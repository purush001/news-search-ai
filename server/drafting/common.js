/** Helpers shared by the platform adapters. */

export function sourceUrls(idea) {
  return [...new Set(idea.sources.map((s) => s.url))];
}

/** What a drafting agent sees about an idea. LinkedIn never sees URLs; X needs them to write source links. */
export function ideaForModel(idea, notes, { withUrls = false } = {}) {
  return {
    headline: idea.headline,
    summary: idea.summary,
    angle: idea.angle,
    confirmedBySources: idea.confirmed,
    proposedApplicationOurInference: idea.application,
    sources: idea.sources.map((s) => ({
      title: s.title,
      source: s.source,
      publishedAt: s.publishedAt,
      primary: s.primary,
      ...(withUrls ? { url: s.url } : {}),
    })),
    editorialNotes: notes || '',
  };
}
