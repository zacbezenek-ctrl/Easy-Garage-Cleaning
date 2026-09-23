/** Conservative triage only. Never infers acceptance, cancellation, or fulfillment. */
export function isCourtesyAcknowledgment(body: string | null): boolean {
  if (!body || body.length > 240) return false;
  const text = body.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
  // The complete message must consist only of these courtesy phrases.
  // A question, request, amount, date, unknown phrase, or bare "yes/okay" stays actionable.
  const phrase = '(?:thanks(?: for the update)?|thank you(?: for the update)?|no worries|no rush|no problem|appreciate it)';
  return new RegExp('^' + phrase + '(?:(?:[,.!;]\\s*|\\s+(?:and\\s+)?|\\s*&\\s*)' + phrase + ')*[.!]*$').test(text);
}

export function inboundReviewCopy(body: string | null) {
  if (isCourtesyAcknowledgment(body)) {
    return {
      title: 'Review customer acknowledgment and outstanding commitments',
      priority: 'medium' as const,
      description: 'This message contains only a courtesy acknowledgment. Review it in context; do not invent an urgent reply. Keep existing photo, quote, product-link, booking, and other commitments open until their own completion evidence is verified.',
      completionCondition: 'Document the acknowledgment review and preserve or separately track outstanding commitments. This review does not prove delivery, acceptance, payment, or completed work.'
    };
  }
  return {
    title: 'Review and respond to customer reply',
    priority: 'high' as const,
    description: 'A customer sent a message that has no later recorded human response. Review its context before responding; booking status does not close this obligation.',
    completionCondition: 'Record a verified human response or a documented decision after reviewing the customer message.'
  };
}
