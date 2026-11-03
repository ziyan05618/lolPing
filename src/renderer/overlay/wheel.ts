import { WHEEL, pickSlice } from '../../shared/geometry';
import { WHEEL_SLOTS } from '../../shared/pings';

const NS = 'http://www.w3.org/2000/svg';
const INNER_RING_START_R = 28;
const MAX_INNER_ITEMS = 16;
/** Kept faintly visible so the slices read as regions, not just as labels floating on the core. */
const INNER_WEDGE_IDLE = 0.1;
const INNER_LABEL_MAX = 5;

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent.append(e);
  return e;
}

const polar = (r: number, deg: number): [number, number] => [r * Math.cos((deg * Math.PI) / 180), r * Math.sin((deg * Math.PI) / 180)];

const fitInnerLabel = (text: string): string => {
  const chars = [...text];
  return chars.length > INNER_LABEL_MAX ? `${chars.slice(0, INNER_LABEL_MAX).join('')}…` : text;
};

function sector(r0: number, r1: number, a0: number, a1: number): string {
  const [x0, y0] = polar(r0, a0);
  const [x1, y1] = polar(r1, a0);
  const [x2, y2] = polar(r1, a1);
  const [x3, y3] = polar(r0, a1);
  return `M${x0},${y0} L${x1},${y1} A${r1},${r1} 0 0 1 ${x2},${y2} L${x3},${y3} A${r0},${r0} 0 0 0 ${x0},${y0}Z`;
}

/** One slice: `key` is what release() hands back, `icon` the image URL drawn in the slice, `label` shown in the centre on hover. */
export interface WheelItem {
  key: string;
  icon: string;
  label?: string;
}

export interface WheelChoice {
  key: string;
  x: number;
  y: number;
  inner?: boolean;
}

function pickRingSlice(dx: number, dy: number, count: number): number {
  const step = 360 / count;
  const deg = ((Math.atan2(dy, dx) * 180) / Math.PI + 90 + step / 2 + 360) % 360;
  return Math.floor(deg / step) % count;
}

/** Longer labels are cut so they stay inside the wheel's centre. */
const CENTER_LABEL_MAX = 14;
const fitLabel = (text: string): string => {
  const chars = [...text];
  return chars.length > CENTER_LABEL_MAX ? `${chars.slice(0, CENTER_LABEL_MAX - 1).join('')}…` : text;
};

/**
 * The League-style wheel (see prototype/wheel-demo.html), for pings or emotes: the slices are whatever items it is given.
 * Each wheel draws into its own svg, whose id keeps its gradient ids apart from the other wheel's.
 */
export class Wheel {
  private readonly wedges: SVGPathElement[] = [];
  private readonly innerWedges: SVGPathElement[] = [];
  private readonly innerLabels: SVGTextElement[] = [];
  private readonly icons: SVGImageElement[] = [];
  private hub: SVGImageElement | null = null;
  private centerTxt: SVGTextElement | null = null;
  private centerHintTxt: SVGTextElement | null = null;
  /** Replaces the constructor's centre text while set. */
  private idleLabel: string | null = null;
  private centerHint: string | null = null;
  private dimmed = new Set<string>();
  private items: readonly WheelItem[] = [];
  private hot = -1;
  private innerHot = -1;
  private ox = 0;
  private oy = 0;
  private opened = false;
  private scale = 1;
  private innerItems: readonly WheelItem[] = [];

  constructor(
    private readonly svg: SVGSVGElement,
    private readonly centerLabel: string,
    private readonly centerIcon: string,
    private readonly onHover: (slice: number) => void,
    private readonly onInnerHover: (slice: number) => void = () => undefined,
  ) {
    this.build();
  }

  /** Changes what each slice holds, top (N) then clockwise. */
  setItems(items: readonly WheelItem[]): void {
    this.items = items;
    this.icons.forEach((icon, i) => {
      const item = items[i];
      if (item) icon.setAttribute('href', item.icon);
      else icon.removeAttribute('href');
    });
    this.setDimmed([...this.dimmed]);
    this.showCenterText();
  }

  setInnerItems(items: readonly WheelItem[]): void {
    this.innerItems = items.slice(0, MAX_INNER_ITEMS);
    const step = 360 / Math.max(this.innerItems.length, 1);
    this.innerLabels.forEach((label, i) => {
      const item = this.innerItems[i];
      label.textContent = item ? fitInnerLabel(item.label ?? '') : '';
      // display was set as an attribute when the element was built; clearing style.display would leave it hidden.
      if (item) label.removeAttribute('display');
      else label.setAttribute('display', 'none');
      if (item) {
        const mid = -90 + i * step;
        const [x, y] = polar((INNER_RING_START_R + WHEEL.innerR - 2) / 2, mid);
        label.setAttribute('x', String(x));
        label.setAttribute('y', String(y + 4));
      }
    });
    this.innerWedges.forEach((wedge, i) => {
      const item = this.innerItems[i];
      if (item) wedge.removeAttribute('display');
      else wedge.setAttribute('display', 'none');
      if (item) {
        const mid = -90 + i * step;
        wedge.setAttribute('fill-opacity', String(INNER_WEDGE_IDLE));
        wedge.setAttribute('d', sector(
          INNER_RING_START_R, WHEEL.innerR - 2, mid - step / 2, mid + step / 2,
        ));
      }
    });
    this.setInnerHot(-1);
  }

  /** The centre's text while no labelled slice is hovered; null puts the wheel's own back. */
  setCenterLabel(text: string | null): void {
    this.idleLabel = text;
    this.showCenterText();
  }

  setCenterHint(text: string | null): void {
    this.centerHint = text;
    this.showCenterText();
  }

  /** Greys out the slices holding these keys (an ask wheel's switched-off intents). */
  setDimmed(keys: string[]): void {
    this.dimmed = new Set(keys);
    this.icons.forEach((icon, i) => {
      const item = this.items[i];
      if (item && this.dimmed.has(item.key)) icon.classList.add('dim');
      else icon.classList.remove('dim');
    });
  }

  /** Changes the icon in the middle of the wheel. */
  setCenterIcon(url: string): void {
    this.hub?.setAttribute('href', url);
  }

  /** Scales the SVG and its dead zone together, keeping the press point at the centre. */
  setSize(sizePx: number): void {
    this.scale = sizePx / WHEEL.size;
    this.svg.style.width = `${sizePx}px`;
    this.svg.style.height = `${sizePx}px`;
    this.svg.style.marginLeft = `${-sizePx / 2}px`;
    this.svg.style.marginTop = `${-sizePx / 2}px`;
  }

  get isOpen(): boolean {
    return this.opened;
  }

  open(x: number, y: number): void {
    this.ox = x;
    this.oy = y;
    this.svg.style.left = `${x}px`;
    this.svg.style.top = `${y}px`;
    this.setHot(-1);
    this.opened = true;
    this.svg.classList.add('open');
  }

  move(x: number, y: number): void {
    if (!this.opened) return;
    const dx = x - this.ox;
    const dy = y - this.oy;
    const distance = Math.hypot(dx, dy);
    if (
      this.innerItems.length > 0 && distance >= INNER_RING_START_R * this.scale && distance < WHEEL.innerR * this.scale
    ) {
      this.setHot(-1);
      this.setInnerHot(pickRingSlice(dx, dy, this.innerItems.length));
    } else {
      this.setInnerHot(-1);
      this.setHot(pickSlice(dx, dy, WHEEL.innerR * this.scale));
    }
  }

  /** Closes the wheel. Returns the chosen item's key at the wheel centre, or null when released in the dead zone. */
  release(x: number, y: number): WheelChoice | null {
    if (!this.opened) return null;
    const dx = x - this.ox;
    const dy = y - this.oy;
    const distance = Math.hypot(dx, dy);
    const inner = this.innerItems.length > 0
      && distance >= INNER_RING_START_R * this.scale
      && distance < WHEEL.innerR * this.scale;
    const slice = inner ? pickRingSlice(dx, dy, this.innerItems.length) : pickSlice(dx, dy, WHEEL.innerR * this.scale);
    this.close();
    const item = slice >= 0 ? (inner ? this.innerItems[slice] : this.items[slice]) : undefined;
    return item ? { key: item.key, x: this.ox, y: this.oy, ...(inner ? { inner: true } : {}) } : null;
  }

  cancel(): void {
    if (this.opened) this.close();
  }

  private close(): void {
    this.opened = false;
    this.svg.classList.remove('open');
    this.setHot(-1);
    this.setInnerHot(-1);
    this.onInnerHover(-1);
  }

  private setHot(i: number): void {
    if (i === this.hot) return;
    if (this.hot >= 0) {
      this.wedges[this.hot].setAttribute('fill-opacity', '0');
      this.icons[this.hot].classList.remove('hot');
    }
    this.hot = i;
    if (i >= 0) {
      this.wedges[i].setAttribute('fill-opacity', '0.55');
      this.icons[i].classList.add('hot');
      if (this.opened) this.onHover(i);
    }
    this.showCenterText();
  }

  private setInnerHot(i: number): void {
    if (i === this.innerHot) return;
    if (this.innerHot >= 0) this.innerWedges[this.innerHot].setAttribute('fill-opacity', String(INNER_WEDGE_IDLE));
    this.innerHot = i;
    if (i >= 0) {
      this.innerWedges[i].setAttribute('fill-opacity', '0.55');
    }
    if (this.opened) this.onInnerHover(i);
    this.showCenterText();
  }

  private showCenterText(): void {
    if (this.centerTxt) {
      const label = this.innerHot >= 0 ? this.innerItems[this.innerHot]?.label : this.hot >= 0 ? this.items[this.hot]?.label : undefined;
      this.centerTxt.textContent = label ? fitLabel(label) : this.idleLabel ?? this.centerLabel;
    }
    if (this.centerHintTxt) this.centerHintTxt.textContent = this.centerHint ?? '';
  }

  private build(): void {
    const { innerR, outerR, extR, iconR, iconSize } = WHEEL;
    const svg = this.svg;
    const id = `lp-${svg.id}`;
    el('defs', {}, svg).innerHTML = `
      <radialGradient id="${id}-ext" cx="0" cy="0" r="${extR}" gradientUnits="userSpaceOnUse">
        <stop offset="${outerR / extR}" stop-color="#5c6066" stop-opacity=".55"/><stop offset="1" stop-color="#5c6066" stop-opacity="0"/></radialGradient>
      <radialGradient id="${id}-ring" cx="0" cy="0" r="${outerR}" gradientUnits="userSpaceOnUse">
        <stop offset="${innerR / outerR}" stop-color="#2a2d31"/><stop offset="1" stop-color="#4a4e54"/></radialGradient>
      <radialGradient id="${id}-hot" cx="0" cy="0" r="${extR}" gradientUnits="userSpaceOnUse">
        <stop offset="${innerR / extR}" stop-color="#8a8f96"/><stop offset="${outerR / extR}" stop-color="#9aa0a8"/>
        <stop offset="1" stop-color="#9aa0a8" stop-opacity="0"/></radialGradient>
      <radialGradient id="${id}-core" cx="0" cy="-10" r="${innerR}" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#2c5d60"/><stop offset="1" stop-color="#11292c"/></radialGradient>`;

    const slots = [...Array(WHEEL_SLOTS).keys()];
    slots.forEach((i) => {
      const mid = -90 + i * 45;
      if (i % 2 === 0) el('path', { d: sector(outerR, extR, mid - 22.5, mid + 22.5), fill: `url(#${id}-ext)` }, svg);
    });

    // Painted before the inner ring: an opaque disc drawn later would cover the whisper wedges and labels, which
    // is exactly what happened — the ring was selectable but invisible.
    el('circle', { r: innerR, fill: `url(#${id}-core)`, stroke: '#c8aa6e', 'stroke-width': 3, class: 'core' }, svg);

    [...Array(MAX_INNER_ITEMS).keys()].forEach((i) => {
      const step = 360 / MAX_INNER_ITEMS;
      const mid = -90 + i * step;
      this.innerWedges.push(el('path', {
        d: sector(INNER_RING_START_R, innerR - 2, mid - step / 2, mid + step / 2),
        fill: `url(#${id}-hot)`, 'fill-opacity': INNER_WEDGE_IDLE, class: 'innerWedge', display: 'none',
        stroke: '#c8aa6e', 'stroke-opacity': 0.3, 'stroke-width': 1,
      }, svg));
      const [x, y] = polar((INNER_RING_START_R + innerR - 2) / 2, mid);
      const label = el('text', { x, y: y + 4, 'text-anchor': 'middle', class: 'innerTxt', display: 'none' }, svg);
      this.innerLabels.push(label);
    });
    el('circle', { r: (innerR + outerR) / 2, fill: 'none', stroke: `url(#${id}-ring)`, 'stroke-width': outerR - innerR, opacity: 0.92 }, svg);
    slots.forEach((i) => {
      const mid = -90 + i * 45;
      const reach = i % 2 === 0 ? extR : outerR;
      this.wedges.push(el('path', { d: sector(innerR, reach, mid - 22.5, mid + 22.5), fill: `url(#${id}-hot)`, 'fill-opacity': 0, class: 'wedge' }, svg));
      const [x0, y0] = polar(innerR, mid - 22.5);
      const [x1, y1] = polar(outerR, mid - 22.5);
      el('line', { x1: x0, y1: y0, x2: x1, y2: y1, stroke: '#a08a5c', 'stroke-opacity': 0.45, 'stroke-width': 1.2 }, svg);
    });
    slots.forEach((i) => {
      const [ix, iy] = polar(iconR, -90 + i * 45);
      this.icons.push(el('image', { x: ix - iconSize / 2, y: iy - iconSize / 2, width: iconSize, height: iconSize, class: 'icon' }, svg));
    });

    el('circle', { r: innerR + 4, fill: 'none', stroke: '#1a1a1a', 'stroke-width': 6, opacity: 0.6 }, svg);
    el('circle', { r: innerR - 7, fill: 'none', stroke: '#8a7448', 'stroke-width': 1, opacity: 0.6 }, svg);
    this.hub = el('image', { href: this.centerIcon, x: -20, y: -58, width: 40, height: 40, class: 'hub' }, svg);
    this.centerTxt = el('text', { x: 0, y: 6, 'text-anchor': 'middle', class: 'centerTxt' }, svg);
    this.centerTxt.textContent = this.centerLabel;
    this.centerHintTxt = el('text', { x: 0, y: 25, 'text-anchor': 'middle', class: 'centerHint' }, svg);
    el('text', { x: 6, y: 50, 'text-anchor': 'middle', class: 'backTxt' }, svg).textContent = 'BACK';
    const mouse = el('g', { opacity: 0.55, transform: 'translate(-26,40)' }, svg);
    el('rect', { x: 0, y: 0, width: 11, height: 16, rx: 5.5, fill: 'none', stroke: '#6c7a7c', 'stroke-width': 1.3 }, mouse);
    el('path', { d: 'M5.5,0 V7 H11 V5.5 A5.5,5.5 0 0 0 5.5,0Z', fill: '#6c7a7c' }, mouse);
  }
}
