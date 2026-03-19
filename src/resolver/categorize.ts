import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;

const BLOCKED_CATEGORIES = [
  'Adult Themes',
  'Pornography & Sexuality',
  'Gambling',
  'Weapons',
  'Drug & Tobacco Use',
  'Hate & Discrimination',
  'Malware',
  'Phishing',
  'Command and Control & Botnet',
  'Violence & Terrorism',
];

export interface CategoryResult {
  domain: string;
  categories: string[];
  blocked: boolean;
  matchedCategory: string | null;
}

export async function categorizeDomain(domain: string): Promise<CategoryResult> {
  try {
    const response = await axios.get(
      `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/intel/domain?domain=${domain}`,
      {
        headers: {
          Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: 3000,
      }
    );

    const data = response.data;

    if (!data.success || !data.result?.content_categories) {
      return {
        domain,
        categories: [],
        blocked: false,
        matchedCategory: null,
      };
    }

    const categories: string[] = data.result.content_categories.map(
      (c: any) => c.name
    );

    const matchedCategory = categories.find((cat) =>
      BLOCKED_CATEGORIES.includes(cat)
    ) || null;

    return {
      domain,
      categories,
      blocked: matchedCategory !== null,
      matchedCategory,
    };
  } catch (err) {
    console.error('Cloudflare categorization error:', err);
    return {
      domain,
      categories: [],
      blocked: false,
      matchedCategory: null,
    };
  }
}