/** Short display name for a market (outcome) within an event. */
export function getMarketDisplayName(
  market: { title?: string | null; outcome_label?: string | null; external_id?: string },
  eventTitle?: string | null
): string {
  const label = market.outcome_label?.trim();
  const title = market.title?.trim();
  const event = eventTitle?.trim();

  if (label) {
    if (!title || title === event) {
      return label;
    }
    if (title.length > label.length + 10) {
      return label;
    }
  }

  if (title && title !== event) {
    return title;
  }

  return label ?? title ?? market.external_id ?? 'Market';
}
