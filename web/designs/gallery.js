(() => {
  'use strict';
  const designs = {
    cinema: { number: '01', title: 'Let time travel begin like a movie.', copy: 'Immersive imagery · Charcoal and sunset orange · Made for atmosphere', name: 'Cinematic Dark' },
    studio: { number: '02', title: 'Make time your creative workspace.', copy: 'Minimal blue and white · Clear controls · Made for creating', name: 'Minimal Studio' },
    postcard: { number: '03', title: 'Send a postcard to the past.', copy: 'Butter yellow and forest green · Tickets and postmarks · Made for adventure', name: 'Travel Journal' }
  };
  const frame = document.querySelector('#design-frame');
  function choose(key, writeHash = true) {
    if (!designs[key]) key = 'cinema';
    const direction = designs[key];
    document.querySelectorAll('[data-design]').forEach(button => {
      const selected = button.dataset.design === key;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    if (frame.getAttribute('src') !== `${key}/`) frame.src = `${key}/`;
    frame.title = `Design ${direction.number}: ${direction.name}`;
    document.querySelector('#standalone-link').href = `${key}/`;
    document.querySelector('#direction-number').textContent = `${direction.number} / 03`;
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
