import * as THREE from 'three';

const RAD = Math.PI / 180;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const normalizeHeading = (heading) => ((heading % 360) + 360) % 360;

export function panoramaHeading(metadata = {}) {
  return Number.isFinite(metadata.heading) ? normalizeHeading(metadata.heading) : 0;
}

export function setCameraBearing(camera, heading, pitch = 0) {
  camera.quaternion.setFromEuler(new THREE.Euler(clamp(pitch, -85, 85) * RAD, -heading * RAD, 0, 'YXZ'));
}

export function cameraBearing(camera) {
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  return { heading: normalizeHeading(Math.atan2(forward.x, -forward.z) / RAD),
    pitch: Math.asin(clamp(forward.y, -1, 1)) / RAD };
}

export function createPanoramaMesh(image, metadata = {}) {
  const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
  if (!width || !height || width !== height * 2) throw new Error('The panorama must be a complete 2:1 image.');
  const texture = new THREE.Texture(image);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter; texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false; texture.needsUpdate = true;
  const geometry = new THREE.SphereGeometry(50, 96, 48);
  geometry.scale(-1, 1, 1);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: texture, depthWrite: false }));
  // Inward sphere: image centre u=.5 faces north (-Z), increasing u faces east.
  // Source heading is a best-effort reference, not measured AR registration.
  mesh.rotation.y = -Math.PI / 2 - panoramaHeading(metadata) * RAD;
  mesh.userData.kind = 'panorama';
  return mesh;
}

export class PanoramaLookControls {
  constructor(camera, element, { onManualInteraction = () => {}, onChange = () => {} } = {}) {
    this.camera = camera; this.element = element; this.enabled = false;
    this.pointers = new Map(); this.handlers = [];
    const listen = (name, callback, options) => {
      element.addEventListener(name, callback, options); this.handlers.push([name, callback]);
    };
    const distance = () => {
      const [a, b] = [...this.pointers.values()];
      return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : null;
    };
    listen('pointerdown', (event) => {
      if (!this.enabled || event.button > 0) return;
      event.preventDefault(); element.focus?.({ preventScroll: true });
      onManualInteraction();
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      element.setPointerCapture?.(event.pointerId);
    });
    listen('pointermove', (event) => {
      const previous = this.pointers.get(event.pointerId);
      if (!this.enabled || !previous) return;
      event.preventDefault();
      const before = distance();
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.pointers.size > 1) {
        const after = distance();
        if (before > 0 && after > 0) {
          camera.fov = clamp(camera.fov * before / after, 35, 90); camera.updateProjectionMatrix();
        }
      } else {
        const { heading, pitch } = cameraBearing(camera);
        const height = Math.max(1, element.clientHeight);
        const scale = camera.fov / height;
        setCameraBearing(camera, heading - (event.clientX - previous.x) * scale,
          pitch + (event.clientY - previous.y) * scale);
      }
      onChange();
    });
    const release = (event) => this.pointers.delete(event.pointerId);
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(name, release);
    listen('wheel', (event) => {
      if (!this.enabled) return;
      event.preventDefault();
      camera.fov = clamp(camera.fov + event.deltaY * 0.03, 35, 90); camera.updateProjectionMatrix();
    }, { passive: false });
    listen('keydown', (event) => {
      if (!this.enabled || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault(); onManualInteraction();
      const { heading, pitch } = cameraBearing(camera);
      setCameraBearing(camera, heading + (event.key === 'ArrowRight' ? 4 : event.key === 'ArrowLeft' ? -4 : 0),
        pitch + (event.key === 'ArrowUp' ? 4 : event.key === 'ArrowDown' ? -4 : 0));
      onChange();
    });
  }

  dispose() {
    this.pointers.clear();
    for (const [name, handler] of this.handlers) this.element.removeEventListener(name, handler);
  }
}
