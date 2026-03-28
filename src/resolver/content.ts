import OpenAI from 'openai';

function getClient() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

const CHILD_THRESHOLDS: Record<string, number> = {
  'sexual': 0.05,
  'sexual/minors': 0.01,
  'violence': 0.15,
  'violence/graphic': 0.05,
  'harassment': 0.15,
  'harassment/threatening': 0.05,
  'hate': 0.05,
  'hate/threatening': 0.01,
  'self-harm': 0.05,
  'self-harm/intent': 0.01,
  'self-harm/instructions': 0.01,
  'illicit': 0.05,
  'illicit/violent': 0.01,
};

export interface ContentVerdict {
  allowed: boolean;
  reason: string;
  scores: Record<string, number>;
}

export async function analyzeContent(
  url: string,
  textSample: string
): Promise<ContentVerdict> {
  const openai = getClient();
  try {
    const response = await openai.moderations.create({
      input: `URL: ${url}\n\nContent: ${textSample.slice(0, 2000)}`,
    });

    const result = response.results[0];
    const scores = result.category_scores as unknown as Record<string, number>;

    const triggeredCategory = Object.entries(CHILD_THRESHOLDS).find(
      ([category, threshold]) => (scores[category] || 0) > threshold
    );

    return {
      allowed: !triggeredCategory,
      reason: triggeredCategory ? triggeredCategory[0] : 'clean',
      scores,
    };
  } catch (err) {
    console.error('Content analysis error:', err);
    return {
      allowed: true,
      reason: 'analysis_failed_default_allow',
      scores: {},
    };
  }
}

export async function fetchPageText(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Meadow-Safety/1.0)',
      },
      signal: AbortSignal.timeout(5000),
    });

    const html = await response.text();

    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return text.slice(0, 3000);
  } catch (err) {
    return '';
  }
}
