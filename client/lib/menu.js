// The red count of overdue tasks on "Tasks and hearings" in the menu, kept right after ticking tasks off.

export function setOverdueBadge(n) {
  const link = document.querySelector('.sidenav a.nav-link[href="/tasks"]');
  if (!link) return;
  let badge = link.querySelector('.badge.count');
  if (!n) {
    if (badge) badge.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'badge rounded-pill text-bg-danger count';
    badge.title = 'Overdue';
    link.append(badge);
  }
  const hidden = document.createElement('span');
  hidden.className = 'visually-hidden';
  hidden.textContent = ' overdue';
  badge.replaceChildren(String(n), hidden);
}
