(() => {
  'use strict';

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const themes = [
    { id: 'ink', name: '夜墨 · 暖金', bg: '#25282d', bubble: '#30343d', fg: '#f1ece2', bubbleFg: '#e9edf5', muted: '#a9a5aa' },
    { id: 'paper', name: '纸笺 · 茶白', bg: '#e6dfd0', bubble: '#faf3e5', fg: '#2c2822', bubbleFg: '#3a342c', muted: '#8a8177' },
    { id: 'forest', name: '林间 · 苔绿', bg: '#293831', bubble: '#dbe8db', fg: '#f1f5ef', bubbleFg: '#27352c', muted: '#a8b9ad' },
    { id: 'sea', name: '暮海 · 雾蓝', bg: '#1c3042', bubble: '#dce6ed', fg: '#f1f5fb', bubbleFg: '#243444', muted: '#9db3c4' },
    { id: 'sakura', name: '樱夜 · 霞粉', bg: '#3a2430', bubble: '#f4d9e4', fg: '#f7e9f0', bubbleFg: '#432734', muted: '#c3a4b1' },
    { id: 'sky', name: '晴空 · 天青', bg: '#dceaf2', bubble: '#f7fcff', fg: '#26323a', bubbleFg: '#2d3a42', muted: '#6f818c' },
    { id: 'amber', name: '琥珀 · 夕照', bg: '#3b2b1f', bubble: '#f3e2c9', fg: '#f7ecdf', bubbleFg: '#44301f', muted: '#bca78b' },
    { id: 'bamboo', name: '竹月 · 霜青', bg: '#23302c', bubble: '#d9ebe2', fg: '#eaf3ee', bubbleFg: '#273a32', muted: '#9fb9ae' },
  ];

  const chapters = {
    meet: { kicker: 'CHAPTER 01 · 见面', title: '先告诉我，怎么称呼你？', text: '开屏不是说明书。你写下名字，她会记住；你点一下主题、服装或快捷键，下一次见面就真的不一样。', asset: 'art/crossed-a0001.webp', tag: '初次见面', state: '初次见面' },
    chat: { kicker: 'CHAPTER 02 · 聊天', title: '话不用整理好，再说也行。', text: '她接着你此刻的话说。分享就对具体的事反应，问问题就直接回答，允许一句话就结束。', asset: 'art/open-a0001.webp', tag: '有来有回', state: '正在聊天' },
    voice: { kicker: 'CHAPTER 03 · 声音', title: '不想打字，就按住说。', text: '按住说话键，松开后文字会落进输入框。可以修改、再发送，也可以随时打断她的播放。', asset: 'art/crossed-a0016.webp', tag: '仔细听', state: '正在听' },
    search: { kicker: 'CHAPTER 04 · 搜索', title: '想知道什么，直接问。', text: '需要查资料时，她会调用搜索；结果里的真实网页和来源会留在对话旁边，方便回头核对。', asset: 'art/crossed-a0009.webp', tag: '带来源', state: '正在查找' },
    observe: { kicker: 'CHAPTER 05 · 看屏幕', title: '要不要一起看屏幕？', text: '屏幕观察始终由你决定。可以只在需要时看、偶尔偷看，或者完全关闭。', asset: 'art/open-a0017.webp', tag: '经过允许', state: '屏幕关闭' },
    placement: { kicker: 'CHAPTER 06 · 摆放', title: '把她放在顺手的位置。', text: '便签可以拖动、缩放，立绘也能在框内移动。放在显示器角落，不挡手边的事。', asset: 'art/crossed-a0017.webp', tag: '刚刚好', state: '调整位置' },
    style: { kicker: 'CHAPTER 07 · 风格', title: '颜色，也是相处的一部分。', text: '八套主题、纯色或自己的图片。你的桌面是什么样，她就跟着变成什么样。', asset: 'art/crossed-a0001.webp', tag: '换一种光', state: '挑选颜色' },
    ready: { kicker: 'CHAPTER 08 · 出发', title: '以后想聊，就按这组键。', text: '默认呼出键是 Ctrl + Alt + A。快捷键可以改，也会检查是否被系统或其它程序占用。', asset: 'art/open-a0001.webp', tag: '随时都在', state: '准备出发' },
  };

  /* ---------- header, progress, nav ---------- */

  const header = $('#siteHeader');
  const progress = $('.scroll-progress i');
  const navLinks = $$('.main-nav a');
  const downloadDock = $('#downloadDock');
  const installSection = $('#install');
  const sections = ['meet', 'features', 'themes', 'screens', 'install', 'releases'].map(id => document.getElementById(id)).filter(Boolean);
  let installVisible = false;

  const updateDock = () => {
    downloadDock?.classList.toggle('is-visible', scrollY > innerHeight * .72 && !installVisible);
  };
  const onScroll = () => {
    header.classList.toggle('is-scrolled', scrollY > 24);
    const max = document.documentElement.scrollHeight - innerHeight;
    progress.style.width = `${max > 0 ? Math.min(1, scrollY / max) * 100 : 0}%`;
    updateDock();
  };
  onScroll();
  addEventListener('scroll', onScroll, { passive: true });
  if (installSection && 'IntersectionObserver' in window) {
    new IntersectionObserver(entries => {
      installVisible = entries.some(entry => entry.isIntersecting);
      updateDock();
    }, { rootMargin: '-10% 0px -10% 0px' }).observe(installSection);
  }

  if ('IntersectionObserver' in window) {
    const navObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        navLinks.forEach(link => link.classList.toggle('is-active', link.getAttribute('href') === `#${entry.target.id}`));
      }
    }, { rootMargin: '-45% 0px -45% 0px' });
    sections.forEach(section => navObserver.observe(section));
  }

  /* ---------- reveal ---------- */

  const revealNodes = $$('.reveal');
  if (reduced || !('IntersectionObserver' in window)) {
    revealNodes.forEach(node => node.classList.add('is-visible'));
  } else {
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    }, { rootMargin: '0px 0px -8% 0px', threshold: .08 });
    revealNodes.forEach(node => observer.observe(node));
  }

  /* ---------- hero note ---------- */

  const noteText = $('#heroNoteText');
  const noteLines = ['今天想聊什么？', '那家书店，后来进去了吗？', '要不要一起看屏幕？', '今天，想听你说。'];
  let noteIndex = 0;
  let noteTimer;

  const wait = ms => new Promise(resolve => setTimeout(resolve, reduced ? 0 : ms));

  async function typeNote() {
    if (!noteText) return;
    const line = noteLines[noteIndex++ % noteLines.length];
    noteText.textContent = '';
    for (const char of line) {
      noteText.textContent += char;
      await wait(65);
    }
    await wait(2600);
    if (reduced) {
      noteText.textContent = line;
      return;
    }
    noteTimer = setTimeout(typeNote, 500);
  }
  typeNote();
  addEventListener('pagehide', () => clearTimeout(noteTimer));

  /* ---------- tour chapters ---------- */

  const tabs = $$('.chapter-tabs button');
  const panes = $$('.demo-pane');
  const tourKicker = $('#tourKicker');
  const tourTitle = $('#tourTitle');
  const tourText = $('#tourText');
  const demoPortrait = $('#demoPortrait');
  const demoPortraitTag = $('#demoPortraitTag');
  const demoState = $('#demoState');

  function selectChapter(id) {
    const data = chapters[id];
    if (!data) return;
    tabs.forEach(tab => {
      const active = tab.dataset.chapter === id;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    panes.forEach(pane => {
      const active = pane.id === `pane-${id}`;
      pane.hidden = !active;
      pane.classList.toggle('is-active', active);
    });
    tourKicker.textContent = data.kicker;
    tourTitle.textContent = data.title;
    tourText.textContent = data.text;
    demoPortraitTag.textContent = data.tag;
    demoState.textContent = data.state;
    if (demoPortrait.getAttribute('src') !== data.asset) {
      demoPortrait.style.opacity = '0';
      demoPortrait.style.transform = 'translateY(8px)';
      setTimeout(() => {
        demoPortrait.src = data.asset;
        demoPortrait.style.opacity = '';
        demoPortrait.style.transform = '';
      }, reduced ? 0 : 130);
    }
    if (id === 'meet') setTimeout(() => $('#demoName')?.focus({ preventScroll: true }), reduced ? 0 : 180);
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectChapter(tab.dataset.chapter));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const target = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[target].focus();
      selectChapter(tabs[target].dataset.chapter);
    });
  });
  tabs.forEach((tab, index) => { tab.tabIndex = index === 0 ? 0 : -1; });

  /* ---------- meet ---------- */

  $('#demoNameForm')?.addEventListener('submit', event => {
    event.preventDefault();
    const input = $('#demoName');
    const name = input.value.trim();
    const result = $('#meetResult');
    if (!name) {
      result.textContent = '还没有名字也没关系，先坐一会儿。';
      input.focus();
      return;
    }
    result.textContent = `「${name}」，记住你了。以后就这么叫你。`;
    result.style.color = 'var(--coral-deep)';
    noteText.textContent = `${name}，今天想聊什么？`;
    noteIndex = 0;
  });

  /* ---------- chat ---------- */

  const demoSend = $('#demoSend');
  demoSend?.addEventListener('click', () => {
    if (demoSend.disabled) return;
    demoSend.disabled = true;
    const reply = $('#demoReply');
    const thread = $('#demoThread');
    const typing = document.createElement('p');
    typing.className = 'bubble bubble-ai typing-bubble';
    typing.innerHTML = '<i></i><i></i><i></i>';
    typing.setAttribute('aria-label', '彩名正在输入');
    thread.append(typing);
    setTimeout(() => {
      typing.remove();
      reply.classList.remove('is-hidden');
      reply.dataset.visible = 'true';
      demoSend.querySelector('span').textContent = '她回复了';
    }, reduced ? 0 : 680);
  });

  /* ---------- voice ---------- */

  const holdButton = $('#holdButton');
  const holdLabel = $('#holdLabel');
  const voiceResult = $('#voiceResult');
  let holding = false;

  function startHold() {
    if (holding) return;
    holding = true;
    holdButton.classList.add('is-holding');
    holdLabel.textContent = '正在听… 松开结束';
  }
  function endHold() {
    if (!holding) return;
    holding = false;
    holdButton.classList.remove('is-holding');
    holdLabel.textContent = '按住说话';
    voiceResult.textContent = '“今天一起去散步吧。” —— 可以改，也可以直接发送。';
    voiceResult.style.color = 'var(--coral-deep)';
  }
  holdButton?.addEventListener('pointerdown', event => {
    event.preventDefault();
    holdButton.setPointerCapture(event.pointerId);
    startHold();
  });
  holdButton?.addEventListener('pointerup', endHold);
  holdButton?.addEventListener('pointercancel', endHold);
  holdButton?.addEventListener('pointerleave', event => { if (event.buttons) endHold(); });
  holdButton?.addEventListener('keydown', event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); startHold(); } });
  holdButton?.addEventListener('keyup', event => { if (event.key === ' ' || event.key === 'Enter') endHold(); });

  /* ---------- search ---------- */

  const queryButton = $('#demoQuery');
  const results = $('#demoResults');
  const sourceResult = $('#sourceResult');
  queryButton?.addEventListener('click', () => {
    queryButton.disabled = true;
    queryButton.querySelector('span').textContent = '正在找…';
    setTimeout(() => {
      results.classList.add('is-open');
      results.setAttribute('aria-hidden', 'false');
      queryButton.querySelector('span').textContent = '找到 3 条来源';
      sourceResult.textContent = '点开一条来源，原网页会留在聊天旁边。';
    }, reduced ? 0 : 520);
  });
  $$('#demoResults button').forEach(button => {
    button.addEventListener('click', () => {
      $$('#demoResults button').forEach(item => item.classList.toggle('is-selected', item === button));
      const title = button.querySelector('b').textContent;
      sourceResult.textContent = `已打开：${title}。来源链接会保留在对话里。`;
    });
  });

  /* ---------- observe ---------- */

  const observe = $('#demoObserve');
  const monitor = $('.demo-monitor');
  const observeResult = $('#observeResult');
  observe?.addEventListener('change', () => {
    monitor.classList.toggle('is-observing', observe.checked);
    observeResult.textContent = observe.checked ? '她可以在需要时看一眼，也可以随时关掉。' : '关闭时，她不会主动看屏幕。';
  });

  /* ---------- placement ---------- */

  const placementBox = $('#placementBox');
  const placementSize = $('#placementSize');
  const placementOutput = $('#placementOutput');
  const placementX = { left: -46, center: 0, right: 46 };
  placementSize?.addEventListener('input', () => {
    placementOutput.textContent = `${placementSize.value}%`;
    placementBox.style.setProperty('--placement-scale', Number(placementSize.value) / 70);
  });
  $$('.placement-actions button').forEach(button => {
    button.addEventListener('click', () => {
      $$('.placement-actions button').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
      placementBox.style.setProperty('--placement-x', `${placementX[button.dataset.place]}px`);
    });
  });

  /* ---------- themes ---------- */

  function applyTheme(node, theme) {
    if (!node) return;
    node.style.setProperty('--note-bg', theme.bg);
    node.style.setProperty('--note-fg', theme.fg);
    node.style.setProperty('--note-muted', theme.muted);
    node.style.setProperty('--bubble-bg', theme.bubble);
    node.style.setProperty('--bubble-fg', theme.bubbleFg);
    node.style.setProperty('--tour-note-bg', theme.bg);
    node.style.setProperty('--tour-note-fg', theme.fg);
    node.style.setProperty('--tour-bubble', theme.bubble);
    node.style.setProperty('--tour-bubble-fg', theme.bubbleFg);
  }

  function buildThemeDots(root, activeId, onPick) {
    if (!root) return;
    root.innerHTML = '';
    themes.forEach(theme => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.theme = theme.id;
      button.setAttribute('aria-label', theme.name);
      button.setAttribute('aria-pressed', String(theme.id === activeId));
      button.innerHTML = `<i style="background:${theme.bg}"></i>`;
      button.addEventListener('click', () => {
        $$('button', root).forEach(item => item.setAttribute('aria-pressed', String(item === button)));
        onPick(theme);
      });
      root.append(button);
    });
  }

  const themeNote = $('#themeNote');
  const themeName = $('#themeName');
  const themeList = $('#themeList');
  let currentTheme = themes[1];

  function pickTheme(theme) {
    currentTheme = theme;
    applyTheme(themeNote, theme);
    if (themeName) themeName.textContent = theme.name;
    themeList?.querySelectorAll('button').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.theme === theme.id));
    });
    const dots = $('#tourThemeDots');
    dots?.querySelectorAll('button').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.theme === theme.id));
    });
    if (themeNote && !reduced) {
      const glow = $('.theme-note-glow', themeNote);
      if (glow) glow.style.background = theme.bubble;
      themeNote.classList.remove('is-washing');
      void themeNote.offsetWidth;
      themeNote.classList.add('is-washing');
      setTimeout(() => themeNote.classList.remove('is-washing'), 780);
    }
  }

  if (themeList) {
    themeList.innerHTML = '';
    themes.forEach(theme => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.theme = theme.id;
      button.setAttribute('aria-pressed', String(theme.id === currentTheme.id));
      button.innerHTML = `<i style="background:${theme.bg}"></i><span>${theme.name}</span>`;
      button.addEventListener('click', () => pickTheme(theme));
      themeList.append(button);
    });
  }
  buildThemeDots($('#tourThemeDots'), 'paper', pickTheme);
  applyTheme(themeNote, currentTheme);
  applyTheme($('#tourThemeNote'), currentTheme);
  if (themeName) themeName.textContent = currentTheme.name;

  /* ---------- voice preview ---------- */

  const previewButton = $('#previewButton');
  const previewWave = $('#voiceWave');
  const audio = new Audio('audio/remember.wav');
  audio.preload = 'auto';
  let previewPlaying = false;

  function setPreviewState(playing) {
    previewPlaying = playing;
    previewWave?.classList.toggle('is-playing', playing);
    if (!previewButton) return;
    const strong = previewButton.querySelector('strong');
    const small = previewButton.querySelector('small');
    const arrow = previewButton.querySelector('.button-arrow');
    if (playing) {
      strong.textContent = '正在播放…';
      small.textContent = '再点一次暂停';
      arrow.textContent = 'Ⅱ';
    } else {
      strong.textContent = '试听一句';
      small.textContent = '「记住了。以后就这么叫你。」';
      arrow.textContent = '▶';
    }
  }

  previewButton?.addEventListener('click', async () => {
    if (previewPlaying) {
      audio.pause();
      setPreviewState(false);
      return;
    }
    try {
      await audio.play();
      setPreviewState(true);
    } catch {
      setPreviewState(false);
    }
  });
  audio.addEventListener('ended', () => setPreviewState(false));
  audio.addEventListener('pause', () => { if (audio.ended) setPreviewState(false); });

  /* ---------- ready / summon ---------- */

  const summonButton = $('#demoSummon');
  const summonResult = $('#summonResult');
  let summoned = false;

  function summonDemo() {
    summoned = !summoned;
    summonButton?.classList.toggle('is-active', summoned);
    if (summonButton) summonButton.textContent = summoned ? '来了，我在呢。' : '试试呼出彩名';
    if (summonResult) summonResult.textContent = summoned ? '便签已经浮到最上面。再按一次就会隐藏。' : '也可以直接按下 Ctrl + Alt + A。';
    noteText.textContent = summoned ? '来了，我在呢。' : '今天想聊什么？';
  }

  summonButton?.addEventListener('click', summonDemo);

  addEventListener('keydown', event => {
    if ($('.chapter-tabs button[aria-selected="true"]')?.dataset.chapter !== 'ready') return;
    if (event.ctrlKey && event.altKey && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      summonDemo();
    }
  });

  /* ---------- install downloads, sha ---------- */

  $$('[data-download]').forEach(link => {
    link.addEventListener('click', () => {
      const label = link.dataset.downloadLabel || '下载 Ayana';
      link.dataset.state = 'downloading';
      const strong = link.querySelector('strong');
      const navSpan = link.querySelector(':scope > span');
      if (strong) {
        if (!strong.dataset.original) strong.dataset.original = strong.textContent;
        strong.textContent = '正在打开下载…';
        setTimeout(() => { strong.textContent = strong.dataset.original || label; link.dataset.state = ''; }, 2200);
      } else if (navSpan) {
        if (!navSpan.dataset.original) navSpan.dataset.original = navSpan.textContent;
        navSpan.textContent = '正在打开下载…';
        setTimeout(() => { navSpan.textContent = navSpan.dataset.original || label; link.dataset.state = ''; }, 2200);
      }
    });
  });

  const copySha = $('#copySha');
  copySha?.addEventListener('click', async () => {
    const text = $('#shaText')?.textContent.trim() || '';
    if (!text) return;
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.append(area);
      area.select();
      copied = document.execCommand('copy');
      area.remove();
    }
    copySha.textContent = copied ? '已复制' : '复制失败';
    setTimeout(() => { copySha.textContent = '复制'; }, 1400);
  });

  /* ---------- screenshots lightbox ---------- */

  const lightbox = $('#lightbox');
  const lightboxImage = $('#lightboxImage');
  const lightboxCaption = $('#lightboxCaption');
  const lightboxClose = $('#lightboxClose');

  function closeLightbox() {
    if (!lightbox) return;
    lightbox.hidden = true;
    document.body.style.overflow = '';
    lightboxImage.src = '';
  }

  $$('.shot-button').forEach(button => {
    button.addEventListener('click', () => {
      const caption = button.closest('.shot')?.dataset.caption || '';
      lightboxImage.src = button.dataset.full;
      lightboxImage.alt = button.querySelector('img')?.alt || 'Ayana 界面截图';
      lightboxCaption.textContent = caption;
      lightbox.hidden = false;
      document.body.style.overflow = 'hidden';
      lightboxClose.focus({ preventScroll: true });
    });
  });
  lightboxClose?.addEventListener('click', closeLightbox);
  lightbox?.addEventListener('click', event => { if (event.target === lightbox) closeLightbox(); });
  addEventListener('keydown', event => { if (event.key === 'Escape' && lightbox && !lightbox.hidden) closeLightbox(); });

  /* ---------- hero parallax ---------- */

  const stage = $('#heroStage');
  if (stage && !reduced && matchMedia('(pointer:fine)').matches) {
    stage.addEventListener('pointermove', event => {
      const box = stage.getBoundingClientRect();
      const x = (event.clientX - box.left) / box.width - .5;
      const y = (event.clientY - box.top) / box.height - .5;
      stage.style.setProperty('--tilt-x', `${x * 5}px`);
      stage.style.setProperty('--tilt-y', `${y * 5}px`);
    });
    stage.addEventListener('pointerleave', () => {
      stage.style.setProperty('--tilt-x', '0px');
      stage.style.setProperty('--tilt-y', '0px');
    });
  }

  if (!reduced && matchMedia('(pointer:fine)').matches) {
    $$('.shot').forEach(shot => {
      shot.addEventListener('pointermove', event => {
        const box = shot.getBoundingClientRect();
        const x = (event.clientX - box.left) / box.width - .5;
        const y = (event.clientY - box.top) / box.height - .5;
        shot.style.setProperty('--shot-ry', `${x * 6}deg`);
        shot.style.setProperty('--shot-rx', `${-y * 6}deg`);
      });
      shot.addEventListener('pointerleave', () => {
        shot.style.setProperty('--shot-ry', '0deg');
        shot.style.setProperty('--shot-rx', '0deg');
      });
    });
  }
})();
