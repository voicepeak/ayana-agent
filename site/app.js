(() => {
  'use strict';

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- nav ---------- */
  const nav = document.getElementById('nav');
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 24);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  /* ---------- reveal ---------- */
  const revealNodes = document.querySelectorAll('.reveal');
  if (reducedMotion || !('IntersectionObserver' in window)) {
    revealNodes.forEach(node => node.classList.add('visible'));
  } else {
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      }
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    revealNodes.forEach(node => observer.observe(node));
  }

  /* ---------- companion mock: themes ---------- */
  const companion = document.getElementById('companionMock');
  const themeChips = companion.querySelectorAll('.theme-chip');
  themeChips.forEach(chip => {
    chip.addEventListener('click', () => {
      companion.dataset.theme = chip.dataset.theme;
      themeChips.forEach(item => item.setAttribute('aria-pressed', String(item === chip)));
    });
  });

  /* ---------- companion mock: typewriter dialogue ---------- */
  const LINES = [
    '在这里。想聊什么？',
    '最新一句会跟着会话出现。',
    '向上滚动，就能回看之前的对话。',
    '接着刚才的话说吧。'
  ];
  const PAUSE_AFTER = new Set(['。', '，', '！', '？', '…', '、', '：']);
  const slots = [0, 1, 2].map(index => companion.querySelector(`.line[data-slot="${index}"]`));
  const [back, middle, active] = slots;
  let lineIndex = 0;

  const setSlot = (slot, text) => {
    slot.textContent = text;
    slot.classList.toggle('muted', slot !== active);
    slot.classList.toggle('active', slot === active);
    slot.classList.toggle('done', slot === active && reducedMotion);
  };

  const rotate = () => {
    back.textContent = middle.textContent;
    middle.textContent = active.textContent;
  };

  const wait = ms => new Promise(resolve => setTimeout(resolve, reducedMotion ? 0 : ms));

  async function typeLine() {
    const text = LINES[lineIndex % LINES.length];
    lineIndex += 1;
    active.classList.remove('done');
    active.textContent = '';
    if (reducedMotion) {
      active.textContent = text;
      active.classList.add('done');
      await wait(4000);
    } else {
      for (const char of text) {
        active.textContent += char;
        await wait(PAUSE_AFTER.has(char) ? 230 : 92);
      }
      active.classList.add('done');
      await wait(2000);
    }
    rotate();
  }

  async function dialogueLoop() {
    setSlot(back, LINES[2]);
    setSlot(middle, LINES[3]);
    active.textContent = '';
    /* eslint-disable no-constant-condition */
    while (true) {
      await typeLine();
    }
  }
  dialogueLoop();

  /* ---------- gallery ---------- */
  const data = window.AYANA_GALLERY;
  const grid = document.getElementById('expressionGrid');
  if (data && grid) {
    const portrait = document.getElementById('galleryPortrait');
    const nameEl = document.getElementById('galleryName');
    const noteEl = document.getElementById('galleryNote');
    const badge = document.getElementById('galleryPoseBadge');
    const poseTabs = document.querySelectorAll('.pose-tab');
    let pose = 'crossed';
    let expression = data.expressions[0];

    const poseLabel = () => data.poses.find(item => item.id === pose).label;

    const renderGrid = () => {
      grid.innerHTML = '';
      data.expressions.forEach(item => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'expression' + (item.name === expression.name ? ' active' : '');
        button.setAttribute('role', 'listitem');
        button.dataset.name = item.name;
        const image = document.createElement('img');
        image.src = item[pose];
        image.alt = `音无彩名：${item.name}`;
        image.loading = 'lazy';
        const label = document.createElement('span');
        label.textContent = item.name;
        button.append(image, label);
        button.addEventListener('click', () => {
          expression = item;
          grid.querySelectorAll('.expression').forEach(node => {
            node.classList.toggle('active', node.dataset.name === item.name);
          });
          updatePreview(item);
        });
        grid.append(button);
      });
    };

    const updatePreview = item => {
      portrait.classList.add('swapping');
      setTimeout(() => {
        portrait.src = item[pose];
        portrait.alt = `音无彩名：${item.name}`;
        portrait.classList.remove('swapping');
      }, reducedMotion ? 0 : 140);
      nameEl.textContent = item.name;
      noteEl.textContent = item.note;
      badge.textContent = `校服 · ${poseLabel()}`;
    };

    poseTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        pose = tab.dataset.pose;
        poseTabs.forEach(item => {
          const selected = item === tab;
          item.classList.toggle('active', selected);
          item.setAttribute('aria-selected', String(selected));
        });
        renderGrid();
        updatePreview(expression);
      });
    });

    renderGrid();
  }

  /* ---------- lightbox ---------- */
  const lightbox = document.getElementById('lightbox');
  const lightboxImage = document.getElementById('lightboxImage');
  const lightboxCaption = document.getElementById('lightboxCaption');
  if (lightbox && typeof lightbox.showModal === 'function') {
    document.querySelectorAll('.shot').forEach(figure => {
      figure.addEventListener('click', () => {
        const image = figure.querySelector('img');
        lightboxImage.src = image.src;
        lightboxImage.alt = image.alt;
        lightboxCaption.textContent = figure.dataset.caption || '';
        document.body.classList.add('lightbox-open');
        lightbox.showModal();
      });
    });
    const close = () => {
      lightbox.close();
      document.body.classList.remove('lightbox-open');
      lightboxImage.src = '';
    };
    lightbox.querySelector('.lightbox-close').addEventListener('click', close);
    lightbox.addEventListener('click', event => {
      if (event.target === lightbox) close();
    });
    lightbox.addEventListener('close', () => {
      document.body.classList.remove('lightbox-open');
      lightboxImage.src = '';
    });
  } else {
    document.querySelectorAll('.shot').forEach(figure => {
      figure.style.cursor = 'default';
    });
  }

  /* ---------- copy buttons ---------- */
  document.querySelectorAll('.copy').forEach(button => {
    button.addEventListener('click', async () => {
      const code = button.closest('.code').querySelector('code');
      const text = code.innerText;
      let copied = false;
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch (error) {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.append(area);
        area.select();
        copied = document.execCommand('copy');
        area.remove();
      }
      button.textContent = copied ? '已复制' : '复制失败';
      button.classList.toggle('done', copied);
      setTimeout(() => {
        button.textContent = '复制';
        button.classList.remove('done');
      }, 1400);
    });
  });
})();
