'use strict';
// Small HTML helpers for consistent, escaped Bootstrap form controls in EJS views.
// Usage in a view:  <%- f.text('heading', 'Heading', values, errors, { required: true }) %>

const esc = (s) => String(s === undefined || s === null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function wrap(name, label, errors, control, opts = {}) {
  const id = opts.id || name;
  const err = errors && errors[name];
  const help = opts.help ? `<div class="form-text" id="${id}-help">${esc(opts.help)}</div>` : '';
  const req = opts.required ? ' <span class="text-danger" aria-hidden="true">*</span>' : '';
  return `<div class="${opts.col || 'col-12'}">
  <label class="form-label" for="${id}">${esc(label)}${req}</label>
  ${control}
  ${err ? `<div class="invalid-feedback d-block" id="${id}-error">${esc(err)}</div>` : ''}${help}
</div>`;
}

function attrs(name, errors, opts) {
  const id = opts.id || name;
  const err = errors && errors[name];
  const described = [err ? `${id}-error` : '', opts.help ? `${id}-help` : ''].filter(Boolean).join(' ');
  return `id="${id}" name="${name}"${opts.required ? ' required' : ''}${err ? ' aria-invalid="true"' : ''}${described ? ` aria-describedby="${described}"` : ''}`;
}

const val = (values, name) => (values && values[name] !== undefined && values[name] !== null ? values[name] : '');

module.exports = {
  esc,

  text(name, label, values, errors, opts = {}) {
    const type = opts.type || 'text';
    const extra = [
      opts.placeholder ? `placeholder="${esc(opts.placeholder)}"` : '',
      opts.min !== undefined ? `min="${opts.min}"` : '',
      opts.max !== undefined ? `max="${opts.max}"` : '',
      opts.step ? `step="${opts.step}"` : '',
      opts.maxlength ? `maxlength="${opts.maxlength}"` : '',
      opts.autocomplete ? `autocomplete="${opts.autocomplete}"` : '',
      opts.inputmode ? `inputmode="${opts.inputmode}"` : '',
      opts.pattern ? `pattern="${esc(opts.pattern)}"` : '',
    ].filter(Boolean).join(' ');
    const v = type === 'password' ? '' : val(values, name);
    const cls = `form-control${errors && errors[name] ? ' is-invalid' : ''}`;
    return wrap(name, label, errors, `<input type="${type}" class="${cls}" ${attrs(name, errors, opts)} value="${esc(v)}" ${extra}>`, opts);
  },

  textarea(name, label, values, errors, opts = {}) {
    const cls = `form-control${errors && errors[name] ? ' is-invalid' : ''}`;
    const ph = opts.placeholder ? ` placeholder="${esc(opts.placeholder)}"` : '';
    return wrap(name, label, errors, `<textarea class="${cls}" rows="${opts.rows || 4}" ${attrs(name, errors, opts)}${ph}>${esc(val(values, name))}</textarea>`, opts);
  },

  /** options: array of strings, or array of {value, label} */
  select(name, label, options, values, errors, opts = {}) {
    const current = String(val(values, name));
    const items = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
    const blank = opts.blank === false ? '' : `<option value="">${esc(opts.blank || 'Select…')}</option>`;
    const html = items.map((o) => `<option value="${esc(o.value)}"${String(o.value) === current ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
    const cls = `form-select${errors && errors[name] ? ' is-invalid' : ''}`;
    return wrap(name, label, errors, `<select class="${cls}" ${attrs(name, errors, opts)}>${blank}${html}</select>`, opts);
  },

  /** Searchable multi-select (a filter box above a list of checkboxes). */
  multi(name, label, options, values, errors, opts = {}) {
    const selected = new Set((values && values[name]) || []);
    const items = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
    const filter = items.length > 8
      ? `<input type="search" class="form-control form-control-sm mb-2" placeholder="Type to filter…" data-filter-list="${name}-list" aria-label="Filter ${esc(label)}">`
      : '';
    const boxes = items.length
      ? items.map((o, i) => `<div class="form-check" data-filter-item>
  <input class="form-check-input" type="checkbox" name="${name}" value="${esc(o.value)}" id="${name}-${i}"${selected.has(String(o.value)) ? ' checked' : ''}>
  <label class="form-check-label" for="${name}-${i}">${esc(o.label)}</label>
</div>`).join('')
      : `<div class="text-muted small">${esc(opts.empty || 'Nothing to choose from yet.')}</div>`;
    const err = errors && errors[name];
    const req = opts.required ? ' <span class="text-danger" aria-hidden="true">*</span>' : '';
    const scroll = items.length > 8 ? ' check-scroll' : '';
    const cols = opts.columns && items.length <= 12 ? ' check-columns' : '';
    return `<fieldset class="${opts.col || 'col-12'}">
  <legend class="form-label fs-6">${esc(label)}${req}</legend>
  ${filter}
  <div class="check-list${scroll}${cols}${err ? ' is-invalid' : ''}" id="${name}-list">${boxes}</div>
  ${err ? `<div class="invalid-feedback d-block">${esc(err)}</div>` : ''}
  ${opts.help ? `<div class="form-text">${esc(opts.help)}</div>` : ''}
</fieldset>`;
  },

  checkbox(name, label, checked, opts = {}) {
    return `<div class="${opts.col || 'col-12'}"><div class="form-check">
  <input class="form-check-input" type="checkbox" id="${name}" name="${name}"${checked ? ' checked' : ''}>
  <label class="form-check-label" for="${name}">${esc(label)}</label>
</div></div>`;
  },

  files(opts = {}) {
    return `<div class="${opts.col || 'col-12'}">
  <label class="form-label" for="attachments">${esc(opts.label || 'Attach files')}</label>
  <input class="form-control" type="file" id="attachments" name="attachments" multiple
    accept=".pdf,.doc,.docx,.xls,.xlsx,.odt,.ods,.txt,.csv,.png,.jpg,.jpeg,.webp,.zip">
  <div class="form-text">Up to 5 files, ${opts.maxMb || 10} MB each. PDF, Word, Excel, images or text.</div>
</div>`;
  },

  hidden(csrfToken, etag) {
    return `<input type="hidden" name="_csrf" value="${esc(csrfToken)}">${etag ? `<input type="hidden" name="_etag" value="${esc(etag)}">` : ''}`;
  },
};
