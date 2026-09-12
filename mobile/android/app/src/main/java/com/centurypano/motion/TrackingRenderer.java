package com.centurypano.motion;

import android.app.Activity;
import android.opengl.GLES11Ext;
import android.opengl.GLES20;
import android.opengl.GLSurfaceView;
import android.os.SystemClock;

import com.google.ar.core.Camera;
import com.google.ar.core.Config;
import com.google.ar.core.Coordinates2d;
import com.google.ar.core.Frame;
import com.google.ar.core.Pose;
import com.google.ar.core.Session;
import com.google.ar.core.TrackingFailureReason;
import com.google.ar.core.TrackingState;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import javax.microedition.khronos.egl.EGLConfig;
import javax.microedition.khronos.opengles.GL10;

/** Real ARCore camera update on a current GLES context, behind the opaque world WebView. */
final class TrackingRenderer implements GLSurfaceView.Renderer {
    interface Sink {
        void packet(long epoch, String state, String code, float[] position, float[] quaternion, long timestamp);
        void failure(long epoch);
    }
    private final Activity activity;
    private final Sink sink;
    private final Object lock = new Object();
    private Session session;
    private long epoch, lastSentNs;
    private FrameClock clock = new FrameClock();
    private TrackingLatch trackingLatch = new TrackingLatch();
    private int texture, program, width = 1, height = 1;
    private boolean bindTexture = true;
    private final FloatBuffer vertices = buffer(new float[]{-1,-1, 1,-1, -1,1, 1,1});
    private final FloatBuffer uv = buffer(new float[8]);
    private String lastState = "";

    TrackingRenderer(Activity activity, Sink sink) { this.activity = activity; this.sink = sink; }

    void start(Session next, long nextEpoch) throws Exception {
        synchronized (lock) {
            closeLocked();
            try {
                Config config = new Config(next);
                config.setUpdateMode(Config.UpdateMode.LATEST_CAMERA_IMAGE);
                config.setFocusMode(Config.FocusMode.AUTO);
                config.setPlaneFindingMode(Config.PlaneFindingMode.DISABLED);
                config.setLightEstimationMode(Config.LightEstimationMode.DISABLED);
                // No recording, cloud anchors, geospatial service, or camera upload.
                next.configure(config);
                next.resume();
                session = next; epoch = nextEpoch; bindTexture = true;
                clock = new FrameClock(); trackingLatch = new TrackingLatch(); lastSentNs = 0; lastState = "";
            } catch (Exception error) { next.close(); throw error; }
        }
    }

    void stop() { synchronized (lock) { closeLocked(); } }
    private void closeLocked() {
        if (session == null) return;
        try { session.pause(); } catch (RuntimeException ignored) { /* Already unavailable. */ }
        session.close(); session = null;
    }

    @Override public void onSurfaceCreated(GL10 unused, EGLConfig config) {
        synchronized (lock) {
            int[] names = new int[1]; GLES20.glGenTextures(1, names, 0); texture = names[0];
            GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, texture);
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR);
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR);
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE);
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE);
            program = GLES20.glCreateProgram();
            GLES20.glAttachShader(program, shader(GLES20.GL_VERTEX_SHADER,
                    "attribute vec2 aPosition; attribute vec2 aUv; varying vec2 vUv;"
                    + "void main(){gl_Position=vec4(aPosition,0.,1.);vUv=aUv;}"));
            GLES20.glAttachShader(program, shader(GLES20.GL_FRAGMENT_SHADER,
                    "#extension GL_OES_EGL_image_external : require\nprecision mediump float;"
                    + "uniform samplerExternalOES uCamera; varying vec2 vUv;"
                    + "void main(){gl_FragColor=texture2D(uCamera,vUv);}"));
            GLES20.glLinkProgram(program);
            int[] linked = new int[1]; GLES20.glGetProgramiv(program, GLES20.GL_LINK_STATUS, linked, 0);
            if (linked[0] == 0) { program = 0; }
            bindTexture = true;
        }
    }

    @Override public void onSurfaceChanged(GL10 unused, int w, int h) {
        synchronized (lock) { width = Math.max(1, w); height = Math.max(1, h); }
        GLES20.glViewport(0, 0, w, h);
    }

    @Override public void onDrawFrame(GL10 unused) {
        GLES20.glClearColor(0.05f, 0.07f, 0.06f, 1);
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT);
        synchronized (lock) {
            if (session == null) return;
            try {
                if (texture == 0 || program == 0) throw new IllegalStateException("GLES unavailable");
                if (bindTexture) { session.setCameraTextureNames(new int[]{texture}); bindTexture = false; }
                session.setDisplayGeometry(activity.getWindowManager().getDefaultDisplay().getRotation(), width, height);
                Frame frame = session.update();
                if (frame.getTimestamp() == 0) return;
                drawCamera(frame);
                long now = SystemClock.elapsedRealtimeNanos();
                Camera camera = frame.getCamera();
                String state = trackingLatch.allowPose(camera.getTrackingState() == TrackingState.TRACKING) ? "tracking" : "limited";
                String code = state.equals("tracking") ? "tracking" : trackingLatch.lost()
                        ? "relocalizing" : reason(camera.getTrackingFailureReason());
                if (now - lastSentNs < 33_333_333L && state.equals(lastState)) return;
                long timestamp = clock.timestamp(frame.getTimestamp(), now, System.currentTimeMillis());
                if (timestamp < 0) return; // No repeated or reversed captures.
                lastSentNs = now; lastState = state;
                if (state.equals("tracking")) {
                    Pose pose = camera.getDisplayOrientedPose();
                    sink.packet(epoch, state, code, pose.getTranslation(), pose.getRotationQuaternion(), timestamp);
                } else sink.packet(epoch, state, code, null, null, timestamp);
            } catch (Exception ignored) {
                long failedEpoch = epoch; closeLocked();
                sink.failure(failedEpoch);
            }
        }
    }

    private void drawCamera(Frame frame) {
        vertices.position(0); uv.position(0);
        frame.transformCoordinates2d(Coordinates2d.OPENGL_NORMALIZED_DEVICE_COORDINATES,
                vertices, Coordinates2d.TEXTURE_NORMALIZED, uv);
        GLES20.glDisable(GLES20.GL_DEPTH_TEST);
        GLES20.glUseProgram(program);
        int position = GLES20.glGetAttribLocation(program, "aPosition");
        int tex = GLES20.glGetAttribLocation(program, "aUv");
        vertices.position(0); uv.position(0);
        GLES20.glVertexAttribPointer(position, 2, GLES20.GL_FLOAT, false, 0, vertices);
        GLES20.glVertexAttribPointer(tex, 2, GLES20.GL_FLOAT, false, 0, uv);
        GLES20.glEnableVertexAttribArray(position); GLES20.glEnableVertexAttribArray(tex);
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, texture);
        GLES20.glUniform1i(GLES20.glGetUniformLocation(program, "uCamera"), 0);
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
        GLES20.glDisableVertexAttribArray(position); GLES20.glDisableVertexAttribArray(tex);
    }

    private static String reason(TrackingFailureReason reason) {
        return switch (reason) {
            case INSUFFICIENT_FEATURES, INSUFFICIENT_LIGHT -> "insufficient_features";
            case EXCESSIVE_MOTION -> "excessive_motion";
            case CAMERA_UNAVAILABLE -> "camera_unavailable";
            case BAD_STATE -> "relocalizing";
            default -> "initializing";
        };
    }
    private static FloatBuffer buffer(float[] values) {
        FloatBuffer result = ByteBuffer.allocateDirect(values.length * 4).order(ByteOrder.nativeOrder()).asFloatBuffer();
        result.put(values).position(0); return result;
    }
    private static int shader(int type, String source) {
        int shader = GLES20.glCreateShader(type); GLES20.glShaderSource(shader, source); GLES20.glCompileShader(shader);
        return shader;
    }
}
