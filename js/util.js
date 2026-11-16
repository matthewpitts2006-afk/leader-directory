// Shared constants and small helpers (dates, text, calendar files).

export const SCHOOLS = [
  { name: 'Westlawn Middle', district: 'City', level: 'Middle' },
  { name: 'Northridge Middle', district: 'City', level: 'Middle' },
  { name: 'Central High', district: 'City', level: 'High' },
  { name: 'Northridge High', district: 'City', level: 'High' },
  { name: 'Duncanville Middle', district: 'County', level: 'Middle' },
  { name: 'Echols Middle', district: 'County', level: 'Middle' },
  { name: 'Hillcrest Middle', district: 'County', level: 'Middle' },
  { name: 'Hillcrest High', district: 'County', level: 'High' },
  { name: 'Tuscaloosa County High', district: 'County', level: 'High' },
];
export const SCHOOL_NAMES = SCHOOLS.map((s) => s.name);
export const schoolByName = (name) => SCHOOLS.find((s) => s.name === name);

export const ASSIGNMENTS = [
  'Westlawn Middle', 'Northridge Middle', 'Duncanville Middle', 'Echols Middle', 'Hillcrest Middle',
  'High School Team', 'All Schools', 'Small Group', 'Weds Hang Out', 'Thurs Hang Out', 'TBD',
];

// Sites an event can happen at: the nine schools plus the groups that are not tied to one school.
export const GROUPS = ['High School Team', 'Small Group', 'Weds Hang Out', 'Thurs Hang Out'];
export const SITES = [...SCHOOL_NAMES, ...GROUPS];
// Teams that keep weekly availability. "All Schools" leaders count as part of every team.
export const TEAMS = ASSIGNMENTS.filter((a) => a !== 'All Schools' && a !== 'TBD');

export const VISIT_TYPES = ['Club', 'Lunch Room Visit', 'Cookie Run', 'Hang Out', 'Small Group', 'Other'];
export const EVENT_CATEGORIES = ['No School', 'Half Day / Early Release', 'E-Learning Day', 'Basketball', 'School Calendar'];
export const CATEGORIES = [...EVENT_CATEGORIES, ...VISIT_TYPES];
export const BLOCKING = ['No School', 'Half Day / Early Release', 'E-Learning Day'];
export const CAT_CLASS = {
  'No School': 'nos', 'Half Day / Early Release': 'half', 'E-Learning Day': 'elearn',
  Basketball: 'bball', 'School Calendar': 'cal', Club: 'club', 'Lunch Room Visit': 'lunch',
  'Cookie Run': 'cookie', 'Hang Out': 'hang', 'Small Group': 'sg', Other: 'other',
};

export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Onboarding
export const STAGES = ['Not Sent', 'Sent App', 'Application Review', 'Background Check', 'Prerequisites', 'Final Decision'];
export const DEFAULT_THRESHOLDS = {
  'Not Sent': 3, 'Sent App': 4, 'Application Review': 3, 'Background Check': 5, Prerequisites: 5, 'Final Decision': 3,
};
export const YEARS = ['Freshmen', 'Soph', 'Junior', 'Senior'];
export const HOLDING_LISTS = ['Next Semester', 'Keep in Mind'];
export const ONBOARDING_TAG = 'Onboarding Team';
export const DEFAULT_SEMESTER_STARTS = ['01-06', '08-01'];
// Used when the calendar data has no "last day for students" entry.
export const LAST_DAY_FALLBACK = { City: '2027-05-26', County: '2027-05-27' };
export const EVENING_START = 16 * 60;

export const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---- dates: plain YYYY-MM-DD strings everywhere, UTC math so nothing shifts by time zone
export const toDate = (iso) => new Date(iso + 'T00:00:00Z');
export const toIso = (d) => d.toISOString().slice(0, 10);
export const addDays = (iso, n) => {
  const d = toDate(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toIso(d);
};
export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const fmtDate = (iso, opts = { weekday: 'short', month: 'short', day: 'numeric' }) =>
  new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }).format(toDate(iso));
export const weekdayName = (iso) => fmtDate(iso, { weekday: 'long' });

// First clock time found in a string, as minutes after midnight. "6:00 PM" and "18:00" both work.
export function parseTime(text) {
  const m = /(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(text || '');
  if (!m) return null;
  let h = Number(m[1]);
  const ap = (m[3] || '').toUpperCase();
  if (ap === 'PM' && h < 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return h * 60 + Number(m[2]);
}
export function fmtTime(hhmm) {
  const mins = parseTime(hhmm);
  if (mins == null) return '';
  const h = Math.floor(mins / 60);
  return `${((h + 11) % 12) + 1}:${String(mins % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

// Minutes after midnight -> "11:15 AM", and -> "11:15" for <input type="time">.
export const fmtMins = (mins) => fmtTime(`${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`);
export const minsToInput = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
// A timestamp from the database as a local YYYY-MM-DD, and whole days from it until today.
export const localDay = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const dayDiff = (fromIso, toIsoDay) => Math.round((toDate(toIsoDay) - toDate(fromIso)) / 86400000);
export const daysSince = (ts) => (ts ? Math.max(0, dayDiff(localDay(ts), todayIso())) : 0);

export function weeklyDates(start, until) {
  const out = [];
  for (let d = start; d <= until && out.length < 200; d = addDays(d, 7)) out.push(d);
  return out;
}

// "City schools" instead of four names, when a list covers a whole district.
export function schoolListLabel(names) {
  const set = new Set(names);
  if (SCHOOL_NAMES.every((n) => set.has(n))) return 'all schools';
  const parts = [];
  for (const district of ['City', 'County']) {
    const group = SCHOOLS.filter((s) => s.district === district).map((s) => s.name);
    if (group.every((n) => set.has(n))) {
      parts.push(`${district} schools`);
      group.forEach((n) => set.delete(n));
    }
  }
  return [...parts, ...SCHOOL_NAMES.filter((n) => set.has(n))].join(', ');
}

// ---- add to calendar
const compact = (iso) => iso.replaceAll('-', '');
const clock = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}${String(mins % 60).padStart(2, '0')}00`;
function span(item) {
  if (item.mins == null) return { allDay: true, start: compact(item.date), end: compact(addDays(item.end || item.date, 1)) };
  const endMins = Math.min(item.mins + (item.durationMin || 60), 23 * 60 + 59);
  return { allDay: false, start: `${compact(item.date)}T${clock(item.mins)}`, end: `${compact(item.date)}T${clock(endMins)}` };
}

export function buildIcs(item) {
  const text = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/([;,])/g, '\\$1').replace(/\r?\n/g, '\\n');
  const fold = (line) => line.match(/.{1,73}/gu).join('\r\n ');
  const s = span(item);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Leader Directory//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VTIMEZONE', 'TZID:America/Chicago',
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0600', 'TZOFFSETTO:-0500', 'TZNAME:CDT', 'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0600', 'TZNAME:CST', 'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    `UID:${item.id}@leader-directory`,
    `DTSTAMP:${stamp}`,
    s.allDay ? `DTSTART;VALUE=DATE:${s.start}` : `DTSTART;TZID=America/Chicago:${s.start}`,
    s.allDay ? `DTEND;VALUE=DATE:${s.end}` : `DTEND;TZID=America/Chicago:${s.end}`,
    `SUMMARY:${text(item.title)}`,
    item.location ? `LOCATION:${text(item.location)}` : '',
    item.description ? `DESCRIPTION:${text(item.description)}` : '',
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return lines.filter(Boolean).map(fold).join('\r\n') + '\r\n';
}

export function downloadIcs(item) {
  const url = URL.createObjectURL(new Blob([buildIcs(item)], { type: 'text/calendar;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  // iPhone Safari shows its own "Add to Calendar" sheet when it opens a calendar file directly.
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!ios) a.download = `${item.title.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'event'}.ics`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function googleCalUrl(item) {
  const s = span(item);
  const p = new URLSearchParams({ action: 'TEMPLATE', text: item.title, dates: `${s.start}/${s.end}` });
  if (!s.allDay) p.set('ctz', 'America/Chicago');
  if (item.location) p.set('location', item.location);
  if (item.description) p.set('details', item.description);
  return `https://calendar.google.com/calendar/render?${p}`;
}
