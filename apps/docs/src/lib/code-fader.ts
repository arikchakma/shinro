import { clamp } from './math';

function setupCodeBlock(block: HTMLElement) {
  if (block.dataset.faderInit) {
    return;
  }
  block.dataset.faderInit = 'true';

  const scroller = block.querySelector<HTMLElement>('pre');
  const leftFader = block.querySelector<HTMLElement>('.code-fader-left');
  const rightFader = block.querySelector<HTMLElement>('.code-fader-right');
  if (!scroller || !leftFader || !rightFader) {
    return;
  }

  const update = () => {
    const maxScroll = scroller.scrollWidth - scroller.clientWidth;
    if (maxScroll <= 0) {
      leftFader.style.opacity = '0';
      rightFader.style.opacity = '0';
      return;
    }

    const { scrollLeft } = scroller;
    leftFader.style.opacity = String(clamp(scrollLeft / 16, [0, 1]));
    rightFader.style.opacity = String(
      clamp((maxScroll - scrollLeft) / 16, [0, 1])
    );
  };

  update();
  requestAnimationFrame(() => {
    block.dataset.faderReady = 'true';
  });

  scroller.addEventListener('scroll', update, { passive: true });
  new ResizeObserver(update).observe(scroller);
}

export function initCodeFaders() {
  document.querySelectorAll<HTMLElement>('.code-block').forEach(setupCodeBlock);
}
