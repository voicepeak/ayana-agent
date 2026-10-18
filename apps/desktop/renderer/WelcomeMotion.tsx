import type { CSSProperties } from 'react';
import './welcome-motion.css';

export type Chapter = 'meet' | 'chat' | 'voice' | 'search' | 'observe' | 'outfit' | 'placement' | 'style' | 'ready';
export const chapterOrder: Chapter[] = ['meet', 'chat', 'voice', 'search', 'observe', 'outfit', 'placement', 'style', 'ready'];
export const motionChapters: Record<Chapter, { word: string; description: string[]; color: string; second: string; duration: number }> = {
  meet: { word: '初次见面', description: ['我是彩名。', '先告诉我，该怎么称呼你？'], color: '#f16b48', second: '#ffd35a', duration: 3800 },
  chat: { word: '有话就说', description: ['点一下发送，', '从第一句话开始聊。'], color: '#4264dc', second: '#b5c7ff', duration: 3800 },
  voice: { word: '说两句吧', description: ['按住快捷键说话，', '松开变成文字，发送前还能改。'], color: '#e66d43', second: '#ffd15c', duration: 4200 },
  search: { word: '帮你查查', description: ['想知道什么，直接问。', '找到的答案，也会带上来源。'], color: '#307c65', second: '#bfe5b4', duration: 4200 },
  observe: { word: '看看屏幕', description: ['需要时，我可以看看你的屏幕。', '要不要开启，由你决定。'], color: '#4264dc', second: '#c2d7f2', duration: 4200 },
  outfit: { word: '换一套吧', description: ['制服，还是现在这样？', '点一套，看看我换上的样子。'], color: '#bf5c83', second: '#f5bdd0', duration: 4200 },
  placement: { word: '坐你旁边', description: ['按住立绘，拖到喜欢的位置。', '滚动鼠标，还能调整大小。'], color: '#348478', second: '#bee5d0', duration: 4200 },
  style: { word: '换个颜色', description: ['点一下色块，', '挑个看着舒服的聊天背景。'], color: '#b35386', second: '#f5b5cb', duration: 3800 },
  ready: { word: '桌面见', description: ['设好呼出快捷键，按一次试试。', '以后想聊，随时叫我。'], color: '#ee7042', second: '#ffd45a', duration: 4200 },
};

/** Decorative full-window cut. Content swaps behind the opaque middle beat. */
export function WelcomeMotion({ chapter }: { chapter: Chapter }) {
  const spec = motionChapters[chapter];
  return <div className="mg-cut" data-cut={chapter} aria-hidden="true" style={{
    '--cut-color': spec.color, '--cut-second': spec.second, '--cut-ms': `${spec.duration}ms`,
  } as CSSProperties}>
    <div className="mg-cut-curtain"/>
    <div className="mg-cut-field">
      <span className="mg-cut-disc"/><span className="mg-cut-orbit"/>
      <div className="mg-cut-art">
        {chapter === 'meet' && <div className="mg-cut-flower">{Array.from({ length: 8 }, (_, i) => <i key={i} style={{ '--n': i } as CSSProperties}/>)}<b>彩</b></div>}
        {chapter === 'chat' && <div className="mg-cut-dialogue"><i>Hi!</i><i>你好。</i><i>↗</i></div>}
        {chapter === 'voice' && <div className="mg-cut-wave">{Array.from({ length: 13 }, (_, i) => <i key={i} style={{ '--n': i, '--bar': 22 + (1 - Math.abs(i - 6) / 7) * 78 } as CSSProperties}/>)}</div>}
        {chapter === 'search' && <div className="mg-cut-lens"><i/><b>?</b><span>✦</span></div>}
        {chapter === 'observe' && <div className="mg-cut-view"><i/><i/><i/><i/><b>＋</b><span/></div>}
        {chapter === 'style' && <div className="mg-cut-ribbons">{['#f17452', '#ffd45a', '#4776dd', '#9ecfa9', '#e991b9'].map((color, i) => <i key={color} style={{ '--n': i, background: color } as CSSProperties}/>)}</div>}
        {chapter === 'outfit' && <div className="mg-cut-outfits"><i/><i/><i/><b>✦</b></div>}
        {chapter === 'placement' && <div className="mg-cut-position"><i/><b>↔</b><span>↕</span></div>}
        {chapter === 'ready' && <div className="mg-cut-arrows"><i>↗</i><i>↗</i><i>↗</i></div>}
      </div>
      <div className="mg-cut-copy">
        <strong>{[...spec.word].map((char, i) => <b key={i} style={{ '--n': i } as CSSProperties}>{char}</b>)}</strong>
        <div className="mg-cut-description">{spec.description.map((line, row) => <p key={row}>{[...line].map((char, i) =>
          <span key={i} style={{ '--char': i, '--row': row } as CSSProperties}>{char}</span>
        )}</p>)}</div>
      </div>
      <div className="mg-cut-speed">{Array.from({ length: 10 }, (_, i) => <i key={i} style={{ '--n': i } as CSSProperties}/>)}</div>
      <span className="mg-cut-number">{String(chapterOrder.indexOf(chapter) + 1).padStart(2, '0')}</span>
    </div>
  </div>;
}
