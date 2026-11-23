import {ScheduleRow} from "./ZGSupply";

/**
 * Finance's token release schedule, "3-1" -- the final version sent to Upbit and Bithumb,
 * replacing the 28-Sep "Exchange Update Sep 2026" schedule this table used to hold.
 *
 * Each row is the amount still locked from that month's unlock onwards, in whole 0G,
 * copied from 3-1's Locked column as it stands. Circulating supply is the live total less
 * that and INFLATION_TIMING_RESERVE:
 *
 *     circulating = totalIssued - (locked + INFLATION_TIMING_RESERVE)
 *
 * Kept as finance writes it -- the locked amount, not the unlocked one -- so a revised
 * schedule is a copy and not a conversion, and a figure that looks wrong can be read
 * against their sheet line for line.
 *
 * Rows switch at 00:00 UTC on the 22nd: 3-1 puts each month's unlock on that day. The
 * label is 3-1's month and the date is the 22nd of it, so the Nov-26 row is in force from
 * 2026-11-22 to 2026-12-21. Past the final row the last one holds -- 0 locked, so only the
 * reserve still comes off, which is what finance asked for until they say otherwise.
 *
 * Every row was checked against 3-1's own Subtract column: locked + 6,000,000 equals it in
 * all 35 rows, and locked falls every month.
 *
 * Updating this needs a deploy. A table that moves once a revision at most is not worth a
 * second place to look when a figure is wrong.
 */
export const TOKEN_RELEASE_SCHEDULE: ScheduleRow[] = [
	{timeline: "Nov-26", date: "2026-11-22", locked: "484401237"},
	{timeline: "Dec-26", date: "2026-12-22", locked: "478210275"},
	{timeline: "Jan-27", date: "2027-01-22", locked: "472019314"},
	{timeline: "Feb-27", date: "2027-02-22", locked: "465828352"},
	{timeline: "Mar-27", date: "2027-03-22", locked: "459637391"},
	{timeline: "Apr-27", date: "2027-04-22", locked: "453446429"},
	{timeline: "May-27", date: "2027-05-22", locked: "447255468"},
	{timeline: "Jun-27", date: "2027-06-22", locked: "441064506"},
	{timeline: "Jul-27", date: "2027-07-22", locked: "434873544"},
	{timeline: "Aug-27", date: "2027-08-22", locked: "428682583"},
	{timeline: "Sep-27", date: "2027-09-22", locked: "422491621"},
	{timeline: "Oct-27", date: "2027-10-22", locked: "403498915"},
	{timeline: "Nov-27", date: "2027-11-22", locked: "384506208"},
	{timeline: "Dec-27", date: "2027-12-22", locked: "365513502"},
	{timeline: "Jan-28", date: "2028-01-22", locked: "346520796"},
	{timeline: "Feb-28", date: "2028-02-22", locked: "327528089"},
	{timeline: "Mar-28", date: "2028-03-22", locked: "308535383"},
	{timeline: "Apr-28", date: "2028-04-22", locked: "289542676"},
	{timeline: "May-28", date: "2028-05-22", locked: "270549970"},
	{timeline: "Jun-28", date: "2028-06-22", locked: "251557263"},
	{timeline: "Jul-28", date: "2028-07-22", locked: "232564557"},
	{timeline: "Aug-28", date: "2028-08-22", locked: "213571851"},
	{timeline: "Sep-28", date: "2028-09-22", locked: "194579144"},
	{timeline: "Oct-28", date: "2028-10-22", locked: "178364216"},
	{timeline: "Nov-28", date: "2028-11-22", locked: "162149287"},
	{timeline: "Dec-28", date: "2028-12-22", locked: "145934358"},
	{timeline: "Jan-29", date: "2029-01-22", locked: "129719430"},
	{timeline: "Feb-29", date: "2029-02-22", locked: "113504501"},
	{timeline: "Mar-29", date: "2029-03-22", locked: "97289572"},
	{timeline: "Apr-29", date: "2029-04-22", locked: "81074644"},
	{timeline: "May-29", date: "2029-05-22", locked: "64859715"},
	{timeline: "Jun-29", date: "2029-06-22", locked: "48644786"},
	{timeline: "Jul-29", date: "2029-07-22", locked: "32429858"},
	{timeline: "Aug-29", date: "2029-08-22", locked: "16214929"},
	{timeline: "Sep-29", date: "2029-09-22", locked: "0"},
];

/**
 * A fixed inflation timing reserve finance holds locked in the Community Rewards wallet,
 * in whole 0G. Subtracted on top of every row, and on its own once the schedule has run
 * out. A constant by finance's definition, so there is no wallet balance to read for it.
 */
export const INFLATION_TIMING_RESERVE = "6000000";
