// A short message at the foot of the screen after an action, with an optional button such as Undo.
import { reactive } from 'vue';

export function useToast(ms = 6000) {
  const toast = reactive({ text: '', error: false, action: null });
  let timer = 0;
  function show(text, { action = null, error = false } = {}) {
    window.clearTimeout(timer);
    Object.assign(toast, { text, error, action });
    timer = window.setTimeout(() => { toast.text = ''; toast.action = null; }, error ? ms * 1.5 : ms);
  }
  function hide() {
    window.clearTimeout(timer);
    toast.text = '';
    toast.action = null;
  }
  return { toast, show, hide };
}

/** Read-only accounts see the live screens without the buttons that change records. */
export const readOnly = () => document.body.classList.contains('read-only');
