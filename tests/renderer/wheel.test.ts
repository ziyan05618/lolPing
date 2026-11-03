import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Wheel } from '../../src/renderer/overlay/wheel';
import { WHEEL } from '../../src/shared/geometry';

/** The SVG operations Wheel uses, without a browser. */
class FakeElement {
  id = '';
  innerHTML = '';
  textContent = '';
  readonly style: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  readonly attrs = new Map<string, string>();
  readonly classes = new Set<string>();
  readonly classList = {
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
  };
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  append(child: FakeElement): void {
    this.children.push(child);
  }
}

function makeWheel(id = 'wheel') {
  const svg = new FakeElement();
  svg.id = id;
  const hover = vi.fn();
  const wheel = new Wheel(svg as unknown as SVGSVGElement, 'WHEEL', 'icon.png', hover);
  wheel.setItems(Array.from({ length: 8 }, (_, i) => ({ key: String(i), icon: `${i}.png` })));
  return { wheel, svg, hover };
}

const polar = (radius: number, degrees: number): [number, number] => [
  radius * Math.cos((degrees * Math.PI) / 180),
  radius * Math.sin((degrees * Math.PI) / 180),
];

function sectorPath(r0: number, r1: number, a0: number, a1: number): string {
  const [x0, y0] = polar(r0, a0);
  const [x1, y1] = polar(r1, a0);
  const [x2, y2] = polar(r1, a1);
  const [x3, y3] = polar(r0, a1);
  return `M${x0},${y0} L${x1},${y1} A${r1},${r1} 0 0 1 ${x2},${y2} L${x3},${y3} A${r0},${r0} 0 0 0 ${x0},${y0}Z`;
}

beforeEach(() => {
  vi.stubGlobal('document', { createElementNS: () => new FakeElement() });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('wheel size', () => {
  it.each(['wheel', 'emoteWheel'])('resizes %s around its original centre', (id) => {
    const { wheel, svg } = makeWheel(id);
    wheel.open(800, 500);
    for (const size of [300, 600, 900]) {
      wheel.setSize(size);
      expect(svg.style).toMatchObject({
        width: `${size}px`, height: `${size}px`, marginLeft: `${-size / 2}px`, marginTop: `${-size / 2}px`,
        left: '800px', top: '500px',
      });
      expect(wheel.isOpen).toBe(true);
    }
  });

  it.each([300, 600, 900])('scales hover and release dead zones at %i px', (size) => {
    const { wheel, hover } = makeWheel();
    wheel.setSize(size);
    const deadZone = WHEEL.innerR * size / 600;
    wheel.open(800, 500);
    wheel.move(800, 500 - deadZone + 1);
    expect(hover).not.toHaveBeenCalled();
    expect(wheel.release(800, 500 - deadZone + 1)).toBeNull();
    wheel.open(800, 500);
    wheel.move(800, 500 - deadZone);
    expect(hover).toHaveBeenCalledWith(0);
    expect(wheel.release(800, 500 - deadZone)).toEqual({ key: '0', x: 800, y: 500 });
    expect(wheel.isOpen).toBe(false);
  });

  it.each([300, 600, 900])('keeps all eight slices aligned at %i px', (size) => {
    const { wheel, hover } = makeWheel();
    wheel.setSize(size);
    for (let i = 0; i < 8; i++) {
      const rad = ((i * 45 - 90) * Math.PI) / 180;
      const r = WHEEL.iconR * size / 600;
      const x = 800 + r * Math.cos(rad);
      const y = 500 + r * Math.sin(rad);
      wheel.open(800, 500);
      wheel.move(x, y);
      expect(hover).toHaveBeenLastCalledWith(i);
      expect(wheel.release(x, y)).toEqual({ key: String(i), x: 800, y: 500 });
    }
  });

  it('uses a new size for a wheel that is already open', () => {
    const { wheel, hover } = makeWheel();
    wheel.open(800, 500);
    wheel.move(800, 400);
    expect(hover).toHaveBeenCalledWith(0);
    wheel.setSize(900);
    wheel.move(800, 400);
    expect(wheel.release(800, 400)).toBeNull();
  });

  it('still cancels after resizing', () => {
    const { wheel, svg } = makeWheel();
    wheel.setSize(300);
    wheel.open(800, 500);
    wheel.move(800, 400);
    wheel.cancel();
    expect(wheel.isOpen).toBe(false);
    expect(svg.classes.has('open')).toBe(false);
    expect(wheel.release(800, 400)).toBeNull();
  });
});

describe('wheel centre', () => {
  it('swaps the centre icon without touching the slices', () => {
    const { wheel, svg } = makeWheel();
    const hrefs = (): string[] => svg.children.filter((c) => c.attrs.has('href')).map((c) => c.attrs.get('href') as string);
    expect(hrefs()).toContain('icon.png');
    wheel.setCenterIcon('other.png');
    expect(hrefs()).toContain('other.png');
    expect(hrefs()).not.toContain('icon.png');
    expect(hrefs().filter((h) => /^\d\.png$/.test(h))).toHaveLength(8);
  });
});

describe('wheel inner ring', () => {
  it('reports the hovered member and returns that member when selected', () => {
    const svg = new FakeElement();
    svg.id = 'wheel';
    const hover = vi.fn();
    const innerHover = vi.fn();
    const wheel = new Wheel(svg as unknown as SVGSVGElement, 'WHEEL', 'icon.png', hover, innerHover);
    wheel.setItems(Array.from({ length: 8 }, (_, i) => ({ key: String(i), icon: `${i}.png` })));
    wheel.setInnerItems([{ key: '1234567890abcdef', icon: '', label: 'Alex' }]);
    const radius = (28 + WHEEL.innerR) / 2;

    wheel.open(800, 500);
    wheel.move(800, 500 - radius);
    expect(innerHover).toHaveBeenLastCalledWith(0);
    expect(wheel.release(800, 500 - radius)).toEqual({ key: '1234567890abcdef', x: 800, y: 500, inner: true });
    expect(innerHover).toHaveBeenLastCalledWith(-1);
    expect(hover).not.toHaveBeenCalled();
  });

  it.each([2, 3, 15])('draws and hits equal sectors with %i room members', (memberCount) => {
    const svg = new FakeElement();
    svg.id = 'wheel';
    const innerHover = vi.fn();
    const wheel = new Wheel(svg as unknown as SVGSVGElement, 'WHEEL', 'icon.png', vi.fn(), innerHover);
    const items = [
      { key: '', icon: '', label: 'Everyone' },
      ...Array.from({ length: memberCount }, (_, i) => ({
        key: `peer-${i}`, icon: '', label: i === 0 ? 'Alexandra' : `Player ${i}`,
      })),
    ];
    wheel.setInnerItems(items);

    const wedges = svg.children.filter((child) => child.attrs.get('class') === 'innerWedge');
    const labels = svg.children.filter((child) => child.attrs.get('class') === 'innerTxt');
    const step = 360 / items.length;
    const radius = (28 + WHEEL.innerR - 2) / 2;
    expect(wedges).toHaveLength(16);
    expect(wedges.slice(0, items.length).every((wedge) => !wedge.attrs.has('display'))).toBe(true);
    expect(wedges.slice(items.length).every((wedge) => wedge.attrs.get('display') === 'none')).toBe(true);
    expect(labels[1].textContent).toBe('Alexa…');

    for (let i = 0; i < items.length; i++) {
      const mid = -90 + i * step;
      expect(wedges[i].attrs.get('d')).toBe(sectorPath(
        28, WHEEL.innerR - 2, mid - step / 2, mid + step / 2,
      ));
      const [labelX, labelY] = polar(radius, mid);
      expect(Number(labels[i].attrs.get('x'))).toBeCloseTo(labelX);
      expect(Number(labels[i].attrs.get('y'))).toBeCloseTo(labelY + 4);

      const [dx, dy] = polar(radius, mid);
      wheel.open(800, 500);
      wheel.move(800 + dx, 500 + dy);
      expect(innerHover).toHaveBeenLastCalledWith(i);
      expect(wheel.release(800 + dx, 500 + dy)).toEqual({
        key: items[i].key, x: 800, y: 500, inner: true,
      });
    }
  });
});

describe('wheel labels', () => {
  const centre = (svg: FakeElement): string =>
    svg.children.find((c) => c.attrs.get('class') === 'centerTxt')?.textContent ?? '';

  it('shows the hovered slice label in the centre', () => {
    const { wheel, svg } = makeWheel();
    wheel.setItems(Array.from({ length: 8 }, (_, i) => ({ key: String(i), icon: `${i}.png`, label: `Label ${i}` })));
    expect(centre(svg)).toBe('WHEEL');
    wheel.open(800, 500);
    wheel.move(800, 360);
    expect(centre(svg)).toBe('Label 0');
    wheel.move(940, 500);
    expect(centre(svg)).toBe('Label 2');
    wheel.move(800, 500);
    expect(centre(svg)).toBe('WHEEL');
    wheel.setCenterLabel('ASK');
    expect(centre(svg)).toBe('ASK');
    wheel.move(800, 360);
    wheel.release(800, 360);
    expect(centre(svg)).toBe('ASK');
    wheel.setCenterLabel(null);
    expect(centre(svg)).toBe('WHEEL');
  });

  it('shows a small centre hint independently of the wheel label', () => {
    const { wheel, svg } = makeWheel();
    wheel.setItems(Array.from({ length: 8 }, (_, i) => ({ key: String(i), icon: `${i}.png`, label: `Label ${i}` })));
    const hint = (): string => svg.children.find((child) => child.attrs.get('class') === 'centerHint')?.textContent ?? '';
    wheel.setCenterHint('Peer too old for private messages');
    expect(hint()).toBe('Peer too old for private messages');
    wheel.open(800, 500);
    wheel.move(800, 360);
    expect(centre(svg)).toBe('Label 0');
    expect(hint()).toBe('Peer too old for private messages');
    wheel.setCenterHint(null);
    expect(hint()).toBe('');
  });

  it('dims the slices it is told to, and only those', () => {
    const { wheel, svg } = makeWheel();
    const icons = svg.children.filter((c) => c.attrs.get('class') === 'icon');
    wheel.setDimmed(['1', '5']);
    expect(icons.map((c) => c.classes.has('dim'))).toEqual([false, true, false, false, false, true, false, false]);
    wheel.setDimmed([]);
    expect(icons.some((c) => c.classes.has('dim'))).toBe(false);
  });
});
