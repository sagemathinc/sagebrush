// The UTC periods active-user counting files by (active-users plan r2 §1.1, §1.2): the day, the ISO week (Monday
// 00:00 UTC) and the calendar month an instant falls in, their starts, and the starts of the next ones.  One function
// for the account counter's flags (A1) and the browser answer's durations, so the two can't disagree.  Pure: the
// caller passes the time (seconds), from its injectable clock.

export interface Periods {
  /** "YYYY-MM-DD" */
  day: string;
  dayStart: number;
  weekStart: number;
  monthStart: number;
  nextDay: number;
  nextWeek: number;
  nextMonth: number;
}

const DAY = 86_400;

export function periods(t: number): Periods {
  const d = new Date(t * 1000);
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  const dayStart = Date.UTC(y, m, d.getUTCDate()) / 1000;
  // (ISO: Monday is the first day of the week; getUTCDay() is 0 on Sunday)
  const weekStart = dayStart - ((d.getUTCDay() + 6) % 7) * DAY;
  const monthStart = Date.UTC(y, m, 1) / 1000;
  return {
    day: d.toISOString().slice(0, 10),
    dayStart,
    weekStart,
    monthStart,
    nextDay: dayStart + DAY,
    nextWeek: weekStart + 7 * DAY,
    nextMonth: Date.UTC(y, m + 1, 1) / 1000,
  };
}
