(() => {
  'use strict';
  const designs = {
    window: { number: '01', title: '让手机，成为时间的视窗。', copy: '全屏全景 · 轻量悬浮控件 · 画面优先', name: '全屏视窗' },
    cinema: { number: '02', title: '让穿越，像电影开场。', copy: '沉浸式大画面 · 炭黑与日落橙 · 情绪优先', name: '电影感深色' },
    studio: { number: '03', title: '把时间，放进工作台。', copy: '蓝白极简 · 清晰操作路径 · 工具体验优先', name: '极简工作台' },
    postcard: { number: '04', title: '给过去，寄一张明信片。', copy: '奶油黄与森林绿 · 票券与邮戳 · 旅行趣味优先', name: '旅行手账' }
  };
  const frame = document.querySelector('#design-frame');
  function choose(key, writeHash = true) {
    if (!designs[key]) key = 'window';
    const direction = designs[key];
    document.querySelectorAll('[data-design]').forEach(button => {
      const selected = button.dataset.design === key;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    if (frame.getAttribute('src') !== `${key}/`) frame.src = `${key}/`;
    frame.title = `方案 ${direction.number}：${direction.name}`;
    document.querySelector('#standalone-link').href = `${key}/`;
    document.querySelector('#direction-number').textContent = `${direction.number} / 04`;
    document.querySelector('#direction-title').textContent = direction.title;
    document.querySelector('#direction-copy').textContent = direction.copy;
    if (writeHash) history.replaceState(null, '', `#${key}`);
  }
  document.querySelectorAll('[data-design]').forEach(button => button.addEventListener('click', () => choose(button.dataset.design)));
  document.querySelectorAll('[data-device]').forEach(button => button.addEventListener('click', () => {
    document.querySelector('#preview-stage').classList.toggle('mobile', button.dataset.device === 'mobile');
    document.querySelectorAll('[data-device]').forEach(item => {
      item.classList.toggle('selected', item === button);
      item.setAttribute('aria-pressed', String(item === button));
    });
  }));
  addEventListener('hashchange', () => choose(location.hash.slice(1), false));
  choose(location.hash.slice(1), false);
})();
