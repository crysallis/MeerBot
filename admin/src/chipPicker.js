import { escHtml } from './utils.js';

const CHIP_STYLE = 'background:var(--color-base-300);border-radius:3px;padding:2px 8px;font-size:12px;display:inline-flex;align-items:center;gap:4px';
const X_STYLE    = 'background:none;border:none;color:var(--color-neutral-content);cursor:pointer;padding:0;font-size:14px;line-height:1';

function makeChip(label, onRemove) {
  const span = document.createElement('span');
  span.setAttribute('style', CHIP_STYLE);
  span.appendChild(document.createTextNode(label));
  const btn = document.createElement('button');
  btn.setAttribute('style', X_STYLE);
  btn.textContent = '×';
  btn.addEventListener('click', onRemove);
  span.appendChild(btn);
  return span;
}

/**
 * Dropdown + removable-chip-collection picker, reused by any admin UI that
 * needs "pick zero or more of these named things" (permissions' roles/channels,
 * text-job mentions, etc.) instead of listing every option on screen as a chip.
 *
 * @param {object} opts
 * @param {{value: string, label: string}[]} opts.options   Pickable options, e.g. [{value:'role:123', label:'@Admins'}]
 * @param {{value: string, label: string}[]} opts.initial    Pre-selected entries
 * @param {string}   [opts.placeholder]  First, unselectable <option> text
 * @param {(selected: {value:string,label:string}[]) => void} [opts.onChange]  Called after every add/remove
 * @returns {{ el: HTMLElement, getSelected: () => {value:string,label:string}[] }}
 */
export function createChipPicker({ options, initial = [], placeholder = '-- add --', onChange }) {
  let selected = [...initial];

  const wrap = document.createElement('div');

  const sel = document.createElement('select');
  sel.innerHTML = `<option value="">${escHtml(placeholder)}</option>` +
    options.map(o => `<option value="${escHtml(o.value)}">${escHtml(o.label)}</option>`).join('');

  const chipsEl = document.createElement('div');
  chipsEl.style.cssText = 'display:flex;flex-wrap:wrap;gap:5px;margin-top:6px;min-height:20px';

  function renderChips() {
    chipsEl.replaceChildren(...selected.map(entry =>
      makeChip(entry.label, () => {
        selected = selected.filter(e => e.value !== entry.value);
        renderChips();
        onChange?.(selected);
      })
    ));
  }

  sel.addEventListener('change', () => {
    const val = sel.value;
    sel.value = '';
    if (!val || selected.some(e => e.value === val)) return;
    const opt = options.find(o => o.value === val);
    if (!opt) return;
    selected = [...selected, opt];
    renderChips();
    onChange?.(selected);
  });

  wrap.append(sel, chipsEl);
  renderChips();

  return { el: wrap, getSelected: () => selected };
}
