'use strict';
// All drop-down lists in one place. Edit these to change the options shown in forms.
// Values are stored as text, so existing records keep their value if an option is renamed.

module.exports = {
  offices: ['Fisenge Office', 'Chief Nkana', 'Kakolo Office', 'Kapoto', 'Kitwe Main Office', 'Digital'],

  districts: ['Lufwanyama District', 'Luanshya District', 'Kitwe District'],

  legalServices: [
    'Legal Information', 'Legal Advice', 'Orientation', 'Accompaniment',
    'Mediation', 'Legal Assistance', 'Negotiation', 'Referral',
  ],

  userCategories: ['Paralegal', 'Lawyer', 'Programme Staff', 'Administrator'],

  qualificationLevels: ['Level one', 'Level two', 'Level three', 'Legal Assistant', 'Advocate'],

  caseStatuses: [
    'Open Active Case', 'Open Referred', 'Open Inactive Case',
    'Concluded Closed Case', 'Concluded Withdrawn Case',
  ],

  caseTypes: [
    'Land and Property', 'Marriage and Family', 'Contract', 'Torts',
    'Labour and Employment', 'Criminal Offences', 'Gender-Based Violence (GBV) related',
    'Public Hearing Meeting', 'Corruption', 'Environmental Rights',
  ],

  activities: [
    'Radio or TV Program', 'Community Meeting', 'Podcast', 'Training Program',
    "Stakeholder's Meeting", 'Social Media Campaign', 'Internet', 'Public Hearing',
    'Door-to-Door Campaign', 'Walk-in / Word of Mouth',
  ],

  ageCategories: ['Girl', 'Boy', 'Woman', 'Man'],

  civilStatuses: ['Single', 'Married', 'Divorced', 'Separated', 'Widow or Widower'],

  disability: ['Not Disabled', 'Disabled'],

  followUpNeeds: ['Needs follow up', 'Does not need follow up'],

  // Recorded when a case is concluded, so results can be reported (not just activity).
  caseOutcomes: [
    'Resolved through mediation',
    'Resolved through negotiation',
    'Resolved by traditional authority',
    'Resolved after legal advice or information',
    'Resolved by partner after referral',
    'Court or tribunal decision in favour of client',
    'Court or tribunal decision against client',
    'Client withdrew',
    'Client could not be reached',
    'No legal remedy available',
    'Other',
  ],

  // Case diary entries
  noteTypes: [
    'Meeting with client', 'Phone call', 'Meeting with other party', 'Mediation session', 'Field visit',
    'Court appearance', 'Letter or document', 'Legal advice given', 'Internal discussion', 'Other',
  ],

  // Tasks, deadlines and appointments
  taskTypes: ['Task', 'Court hearing', 'Mediation session', 'Meeting', 'Follow up', 'Deadline', 'Field visit'],

  roles: ['officer', 'admin'],
};
