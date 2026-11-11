'use strict';
// Where an activity report's attendance stands. Kept apart from services/attendance.js so the services
// that count people (work plans, statistics, logframes) can use it without circular imports.
const STATUSES = ['Draft', 'Submitted', 'Returned', 'Approved'];
const LOCKED = ['Submitted', 'Approved'];
const LABEL = {
  Draft: 'Not submitted', Submitted: 'Waiting for approval', Returned: 'Returned for correction', Approved: 'Approved',
};
/** Reports written before approval existed have no status: their attendance stands as approved. */
const statusOf = (r) => (STATUSES.includes(r && r.attendanceStatus) ? r.attendanceStatus : 'Approved');
/** Only approved attendance counts in statistics, work plan progress and the logframe. */
const counts = (r) => statusOf(r) === 'Approved';
const locked = (r) => LOCKED.includes(statusOf(r));

module.exports = {
  STATUSES, LOCKED, LABEL, statusOf, counts, locked,
};
