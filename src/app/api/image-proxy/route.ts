import { NextResponse } from 'next/server';

export const runtime = 'edge';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

// 上游取图失败时返回占位图，保证 <img> 永远不出现破图标 + alt 文本
const FALLBACK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e8edf2"/><stop offset="1" stop-color="#cdd6e0"/></linearGradient></defs>
<rect width="300" height="450" fill="url(#g)"/>
<g fill="none" stroke="#94a3b8" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">
<rect x="92" y="176" width="116" height="98" rx="10"/>
<circle cx="150" cy="225" r="26"/>
<path d="M112 176l-14-18h104l-14 18"/>
</g>
<text x="150" y="312" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#64748b">暂无海报</text>
</svg>`;

const CACHE_HEADERS = {
  'Cache-Control': 'public, max-age=86400, s-maxage=604800',
  'CDN-Cache-Control': 'public, s-maxage=604800',
  'Vercel-CDN-Cache-Control': 'public, s-maxage=604800',
};

function fallback(): Response {
  return new Response(FALLBACK_SVG, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      // 占位图只短缓存，避免上游临时故障被 CDN 固化
      'Cache-Control': 'public, max-age=60, s-maxage=60',
    },
  });
}

/** 阻断内网 / 云元数据地址，避免该端点被当作 SSRF 跳板 */
function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.localhost')
  ) {
    return true;
  }

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }

  // URL.hostname 对 IPv6 保留冒号，且不带端口；此处一律拦截
  return host.includes(':');
}

/** 豆瓣图床必须带豆瓣 Referer，其它站点回落到自身 origin */
function refererFor(url: URL): string {
  return /(^|\.)(douban|doubanio)\.com$/.test(url.hostname)
    ? 'https://movie.douban.com/'
    : `${url.protocol}//${url.host}/`;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const imageUrl = searchParams.get('url');

  if (!imageUrl) {
    return NextResponse.json({ error: 'Missing image URL' }, { status: 400 });
  }

  let target: URL;
  try {
    target = new URL(imageUrl);
  } catch {
    return fallback();
  }

  if (!['http:', 'https:'].includes(target.protocol) || isBlockedHost(target.hostname)) {
    return fallback();
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const imageResponse = await fetch(target.toString(), {
      signal: controller.signal,
      headers: {
        Referer: refererFor(target),
        'User-Agent': UA,
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
    });

    const contentType = imageResponse.headers.get('content-type') || '';

    // 豆瓣反爬会返回 418 且 content-type 伪装成 image/jpeg，需按内容类型再校验
    if (
      !imageResponse.ok ||
      !imageResponse.body ||
      !contentType.toLowerCase().startsWith('image/')
    ) {
      return fallback();
    }

    return new Response(imageResponse.body, {
      status: 200,
      headers: new Headers({ 'Content-Type': contentType, ...CACHE_HEADERS }),
    });
  } catch {
    return fallback();
  } finally {
    clearTimeout(timeoutId);
  }
}
