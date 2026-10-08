// Injected into the user's site. Runs on Netlify's Deno edge runtime: no npm
// imports, config must stay inline, and env access goes through Netlify.env.
declare const Netlify: {
  env: { get(name: string): string | undefined };
};

type EdgeContext = { next(): Promise<Response> };

// Encited's crawler list (CRAWLER_USER_AGENT_PATTERN in the Encited repo).
// Only these agents reach Encited; browsers never leave the customer's site.
// Update this copy when that list changes.
const CRAWLER =
  /(?:(OAI-SearchBot|ChatGPT-User(?:\/\d+\.\d+)?|GPTBot|ChatGPT|OpenAI-))|(?:(anthropic-ai|ClaudeBot|claude-web|Claude-Web|Claude-User|Claude-SearchBot))|(?:\b(GrokBot|xAI-Grok|xAI-Bot|xAI-SearchBot)\b)|(?:(PerplexityBot|Perplexity-User))|(?:(Google-InspectionTool|GoogleOther(?:-Image|-Video)?|Googlebot|Google-CloudVertexBot|Storebot-Google|Google-NotebookLM|GoogleAgent-URLContext|GoogleAIOverviewRenderer|Google-Lens|Google-Jetski-Antigravity))|(?:(Microsoft-Copilot|CopilotBot|Copilot-Chat|Microsoft-CopilotPlugin))|(?:(BingBot|bingbot|BingPreview))|(?:facebookexternalhit.*Twitterbot|Twitterbot.*facebookexternalhit)|(?:(Meta-ExternalAgent|meta-externalagent|meta-externalfetcher|MetaBot|FacebookBot|facebookexternalhit))|(?:LinkedInBot)|(?:Amazonbot)|(?:(Applebot-Extended|Applebot|AppleNewsBot))|(?:Bytespider)|(?:(DuckAssistBot|DuckDuckBot))|(?:(cohere-training-data-crawler|cohere-ai|CohereAI))|(?:MistralAI-User)|(?:AI2Bot)|(?:CCBot)|(?:Diffbot)|(?:omgili)|(?:TimpiBot)|(?:YouBot)|(?:ExaSearchBot)|(?:(Bravebot|Brave-Search))|(?:Yandex)|(?:Twitterbot)|(?:Discordbot)|(?:(Slackbot|Slack-ImgProxy))|(?:TelegramBot)|(?:(Pinterest|Pinterestbot))|(?:Snapchat)|(?:Redditbot)|(?:Tumblr)|(?:(Mastodon|http\.rb))|(?:Viber)|(?:^Line\/)|(?:WhatsApp)|(?:(SkypeUriPreview|Skype))|(?:(Teams|MicrosoftPreview))|(?:Zoom)|(?:Notion)|(?:(Quora|QuoraBot|Quora-Bot|Poe-Bot))|(?:Medium)|(?:(Pocket|PocketParser|PocketImageCache))|(?:(Flipboard|FlipboardProxy))|(?:(Embedly|embed\.ly))|(?:YelpBot)|(?:(Baiduspider|Baidu))|(?:(Sogou|sogou))|(?:(Yeti|NaverBot|Naver))|(?:SeznamBot)|(?:(Qwantify|Qwant))|(?:Ecosia)|(?:MojeekBot)|(?:Mail\.RU_Bot)|(?:(Yahoo! Slurp|Y!J-))|(?:(SemrushBot|SEMrush))|(?:(AhrefsBot|AhrefsSiteAudit))|(?:(DotBot|Rogerbot|moz\.com))|(?:MJ12bot)|(?:Screaming Frog)|(?:SISTRIX)|(?:SEOkicks)|(?:serpstatbot)|(?:RSiteAuditor)|(?:(?:Encited|LvHTML)-SEOAuditBot)|(?:Barkrowler)|(?:HubSpot Crawler)|(?:(AwarioSmartBot|AwarioBot))|(?:DataForSeoBot)|(?:SERanking)|(?:Seobility)/i;

export default async (request: Request, context: EdgeContext) => {
  const apiKey = Netlify.env.get("ENCITED_API_KEY");
  const enabled = Netlify.env.get("ENCITED_PRERENDER_ENABLED") === "true";
  if (!apiKey || !enabled) return context.next();

  // Encited's own render browser stamps this on same-origin requests; passing
  // it through prevents a render → edge function → render recursion loop.
  if (request.headers.get("x-lovablehtml-internal") === "1") {
    return context.next();
  }

  // Only handle crawler GET requests for HTML.
  // Treat missing/empty Accept and bare '*/*' as HTML so crawler tests
  // (curl -A Googlebot) still route through prerender.
  // Asset requests from browsers send specific Accept (e.g. 'text/css,*/*;q=0.1')
  // so they won't match.
  const accept = (request.headers.get("accept") || "").trim();
  const isHtmlRequest =
    !accept || accept === "*/*" || accept.includes("text/html");
  const userAgent = request.headers.get("user-agent") || "";
  if (request.method !== "GET" || !isHtmlRequest || !CRAWLER.test(userAgent)) {
    return context.next();
  }

  const baseUrl = Netlify.env.get("ENCITED_BASE_URL") || "https://encited.com";
  const headers = {
    authorization: `Bearer ${apiKey}`,
    accept: "text/html",
    "accept-language": request.headers.get("accept-language") || "",
    "sec-fetch-mode": request.headers.get("sec-fetch-mode") || "",
    "sec-fetch-site": request.headers.get("sec-fetch-site") || "",
    "sec-fetch-dest": request.headers.get("sec-fetch-dest") || "",
    "sec-fetch-user": request.headers.get("sec-fetch-user") || "",
    "upgrade-insecure-requests":
      request.headers.get("upgrade-insecure-requests") || "",
    referer: request.headers.get("referer") || "",
    "user-agent": userAgent,
  };

  try {
    // Bounded so a hung Encited can never stall the customer's page loads —
    // on timeout the catch below fails open to the SPA.
    const r = await fetch(
      `${baseUrl}/api/prerender/render?url=${encodeURIComponent(request.url)}`,
      { headers, redirect: "manual", signal: AbortSignal.timeout(15_000) },
    );

    // 301 = configured redirect rule matched - forward to client
    if (r.status === 301) {
      const loc = r.headers.get("location");
      if (loc) {
        return new Response(null, {
          status: 301,
          headers: { location: loc, "cache-control": "no-store" },
        });
      }
    }

    // 304 = not pre-rendered, pass through to the SPA
    if (r.status === 304) {
      return context.next();
    }

    if (
      r.status === 200 &&
      (r.headers.get("content-type") || "").includes("text/html")
    ) {
      const responseHeaders = new Headers(r.headers);
      for (const name of [
        "content-encoding",
        "content-length",
        "transfer-encoding",
        "connection",
        "keep-alive",
        // Upstream infrastructure headers from Encited's CDN — noise on the
        // customer site's responses.
        "alt-svc",
        "cf-cache-status",
        "cf-ray",
        "nel",
        "report-to",
      ]) {
        responseHeaders.delete(name);
      }
      responseHeaders.set("content-type", "text/html; charset=utf-8");
      return new Response(r.body, { status: 200, headers: responseHeaders });
    }
  } catch {
    // Encited unreachable → continue to the existing Netlify request chain
  }

  return context.next();
};

export const config = {
  path: "/*",
  // Static assets never prerender (Encited 304s them anyway); excluding them
  // here just avoids billing an edge invocation per asset request.
  excludedPath: [
    "/.netlify/*",
    "/*.js",
    "/*.mjs",
    "/*.css",
    "/*.map",
    "/*.json",
    "/*.txt",
    "/*.xml",
    "/*.ico",
    "/*.png",
    "/*.jpg",
    "/*.jpeg",
    "/*.gif",
    "/*.webp",
    "/*.avif",
    "/*.svg",
    "/*.woff",
    "/*.woff2",
    "/*.ttf",
    "/*.otf",
    "/*.mp4",
    "/*.webm",
    "/*.mp3",
    "/*.pdf",
    "/*.wasm",
  ],
  onError: "bypass",
};
