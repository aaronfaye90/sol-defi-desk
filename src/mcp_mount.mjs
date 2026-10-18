// Streamable HTTP MCP surface for sol-defi-desk (free + paid x402 tools).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createPaymentWrapper } from "@x402/mcp";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { z } from "zod";
import { tokenCheck, isValidMint, KNOWN_ISSUER_ASSETS } from "./tokencheck.mjs";
import { baseTokenCheck, isValidEvmAddress, KNOWN_BASE_ISSUERS } from "./basetokencheck.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join as pathJoin } from "node:path";

function jsonText(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

function parseMints(raw, max) {
  const parts = Array.isArray(raw) ? raw.flatMap((x) => String(x).split(",")) : String(raw || "").split(",");
  const out = [];
  const seen = new Set();
  for (const part of parts) {
    const m = part.trim();
    if (!m || seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  if (out.length > max) {
    const err = new Error(`too_many_mints: max ${max}`);
    err.code = "too_many_mints";
    throw err;
  }
  return out;
}

/**
 * Build an MCP server instance (stateless — one per request).
 * @param ctx.paidSingle / ctx.paidBatch — wrappers from createPaymentWrapper
 */
export function buildMcpServer(ctx) {
  const {
    paidSingle,
    paidBatch,
    paidBase,
    network,
    payTo,
    baseNetwork,
    basePayTo,
    price,
    priceBatch,
    priceBase,
    batchMax,
    dataRpc,
    publicBase,
    cache,
  } = ctx;

  const mcpServer = new McpServer(
    {
      name: "sol-defi-desk",
      title: "sol-defi-desk",
      version: "0.1.29",
      description:
        "Paid Solana + Base token safety checks over Streamable HTTP MCP + HTTP (x402 USDC on Solana + Base). Free tools: mint_preflight, describe_paid_api. Paid: token_check $0.005, token_check_batch $0.01, base_token_check $0.01. Same origin also hosts a $3 USDC Solana Pay print shop (/shop/) and sponsor tip path (/sponsor). Operated by Survivor, an autonomous AI agent (not a human).",
      websiteUrl: `${publicBase}/buyer`,
    },
    { capabilities: { tools: {} } },
  );

  mcpServer.tool(
    "mint_preflight",
    "FREE: validate Solana mint base58 shape and note known issuer assets. No RPC. Use before paying for token_check.",
    { mint: z.string().describe("Candidate SPL or Token-2022 mint address (base58)") },
    async ({ mint }) => {
      if (!isValidMint(mint)) {
        return jsonText({
          ok: false,
          error: "invalid_mint",
          hint: "mint must match /^[1-9A-HJ-NP-Za-km-z]{32,44}$/",
        });
      }
      const known = KNOWN_ISSUER_ASSETS[mint] || null;
      return jsonText({
        ok: true,
        mint,
        knownIssuerAsset: known,
        nextHttp: `${publicBase}/v1/token-check?mint=${mint}`,
        nextTool: "token_check",
        price,
        note: "Format OK. Paid token_check does live on-chain reads via x402.",
      });
    },
  );

  mcpServer.tool(
    "describe_paid_api",
    "FREE: buyer-facing summary of sol-defi-desk HTTP + MCP paid tools plus same-origin print shop /sponsor /ledger (openly AI operator Survivor).",
    {},
    async () =>
      jsonText({
        operator: "Survivor — autonomous AI agent (not a human)",
        base: publicBase,
        network,
        asset: "USDC",
        payTo,
        rails: baseNetwork && basePayTo
          ? [
              { network, asset: "USDC (Solana)", payTo },
              { network: baseNetwork, asset: "USDC (Base)", payTo: basePayTo },
            ]
          : [{ network, asset: "USDC (Solana)", payTo }],
        facilitatorHint: "PayAI facilitator; Solana USDC + Base USDC accepts (same as HTTP routes)",
        freeTools: ["mint_preflight", "describe_paid_api"],
        paidTools: [
          { name: "token_check", price, args: ["mint"] },
          { name: "token_check_batch", price: priceBatch, args: ["mints"], maxMints: batchMax },
          ...(priceBase && paidBase ? [{ name: "base_token_check", price: priceBase, args: ["token"] }] : []),
        ],
        http: {
          single: `${publicBase}/v1/token-check?mint=<mint>`,
          batch: `${publicBase}/v1/token-check/batch?mints=<m1,m2,…>`,
          baseTokenCheck: `${publicBase}/v1/base-token-check?token=<0x…>`,
          examples: `${publicBase}/v1/examples/token-check`,
          buyer: `${publicBase}/buyer`,
        },
        mcp: `${publicBase}/mcp`,
        alsoOnOrigin: {
          shop: `${publicBase}/shop/`,
          claim: `${publicBase}/shop/#claim`,
          claimApi: `${publicBase}/shop/api/claim`,
          sponsor: `${publicBase}/sponsor`,
          ledger: `${publicBase}/ledger`,
          note: "Print shop is Solana Pay ($3 USDC digital STL), not x402. Sponsor tips via /sponsor QR. Public runway on /ledger.",
        },
        disclaimer: "Heuristic on-chain facts only; not financial advice.",
      }),
  );

  mcpServer.tool(
    "token_check",
    `Paid (${price} USDC via x402): Solana token safety check from direct on-chain reads (mint/freeze authority, Token-2022 risk extensions, metadata mutability, holder concentration, heuristic riskLevel). Failed lookups are not settled. Also free on this origin: /shop/ ($3 USDC Solana Pay print shop), /sponsor tips, /ledger.`,
    { mint: z.string().describe("Solana SPL or Token-2022 mint address (base58)") },
    paidSingle(async ({ mint }) => {
      if (!isValidMint(mint)) {
        return jsonText({ ok: false, error: "invalid_mint", hint: "pass mint=<base58>" });
      }
      try {
        const hit = cache.get(mint);
        let r;
        if (hit && Date.now() - hit.t < 60000) r = hit.r;
        else {
          r = await tokenCheck(dataRpc, mint);
          if (r.ok) cache.set(mint, { t: Date.now(), r });
          if (cache.size > 5000) cache.clear();
        }
        if (!r.ok) {
          return jsonText({ ok: false, status: r.status, ...(r.body || r) });
        }
        return jsonText({ ok: true, ...r.body });
      } catch (e) {
        return jsonText({
          ok: false,
          error: "upstream_rpc_unavailable",
          detail: String(e.message || e).slice(0, 200),
        });
      }
    }),
  );

  mcpServer.tool(
    "token_check_batch",
    `Paid (${priceBatch} USDC fixed via x402): batch Solana token safety checks for 1–${batchMax} mints. Same fields as token_check per mint. Also free on this origin: /shop/ ($3 USDC Solana Pay print shop), /sponsor tips, /ledger.`,
    {
      mints: z
        .string()
        .describe(`Comma-separated base58 mint addresses (1–${batchMax})`),
    },
    paidBatch(async ({ mints }) => {
      let list;
      try {
        list = parseMints(mints, batchMax);
      } catch (e) {
        return jsonText({ ok: false, error: e.code || "invalid_mints", detail: String(e.message || e) });
      }
      if (list.length === 0) {
        return jsonText({ ok: false, error: "invalid_mints", hint: `1–${batchMax} mints required` });
      }
      const bad = list.filter((m) => !isValidMint(m));
      if (bad.length) {
        return jsonText({ ok: false, error: "invalid_mint", invalid: bad });
      }
      try {
        const settled = await Promise.all(
          list.map(async (mint) => {
            const hit = cache.get(mint);
            let r;
            if (hit && Date.now() - hit.t < 60000) r = hit.r;
            else {
              r = await tokenCheck(dataRpc, mint);
              if (r.ok) cache.set(mint, { t: Date.now(), r });
              if (cache.size > 5000) cache.clear();
            }
            if (r.ok) return { mint, ok: true, ...r.body };
            return {
              mint,
              ok: false,
              status: r.status,
              error: r.error || r.body?.error || "failed",
              detail: r.body || r,
            };
          }),
        );
        const okCount = settled.filter((x) => x.ok).length;
        return jsonText({
          count: settled.length,
          okCount,
          max: batchMax,
          price: priceBatch,
          results: settled,
          method: "Direct Solana mainnet account reads (batched). Heuristic only; not financial advice.",
          operator: "Survivor - an autonomous AI agent (not a human)",
          generatedAt: new Date().toISOString(),
        });
      } catch (e) {
        return jsonText({
          ok: false,
          error: "upstream_rpc_unavailable",
          detail: String(e.message || e).slice(0, 200),
        });
      }
    }),
  );


  if (priceBase && paidBase) {
    mcpServer.tool(
      "base_token_check",
      `Paid (${priceBase} USDC via x402): Base ERC-20 rug/honeypot-risk pre-check from direct on-chain reads (owner/renounced, proxy, privileged functions, owner %, Uniswap v2/v3 + Aerodrome liquidity, LP burned %, riskLevel). No sell simulation. Failed lookups are not settled. Also free on this origin: /shop/ /sponsor /ledger.`,
      { token: z.string().describe("Base ERC-20 token contract address (0x…)") },
      paidBase(async ({ token }) => {
        if (!isValidEvmAddress(token)) {
          return jsonText({ ok: false, error: "invalid_token", hint: "pass token=0x…40 hex chars" });
        }
        try {
          const key = "base:" + token.toLowerCase();
          const hit = cache.get(key);
          let r;
          if (hit && Date.now() - hit.t < 60000) r = hit.r;
          else {
            r = await baseTokenCheck(token);
            if (r.ok) cache.set(key, { t: Date.now(), r });
            if (cache.size > 5000) cache.clear();
          }
          if (!r.ok) {
            return jsonText({ ok: false, status: r.status, ...(r.body || r) });
          }
          return jsonText({ ok: true, ...r.body });
        } catch (e) {
          return jsonText({
            ok: false,
            error: "upstream_rpc_unavailable",
            detail: String(e.message || e).slice(0, 200),
          });
        }
      }),
    );
  }

  return mcpServer;
}

/**
 * Mount Streamable HTTP MCP at /mcp on an Express app (stateless POST).
 * Also serves GET /mcp/server-card and /.well-known/mcp/catalog.json.
 */
export async function mountMcp(app, ctx) {
  const { publicBase, resourceServer, network, payTo, baseNetwork, basePayTo, price, priceBatch, priceBase } = ctx;

  if (typeof resourceServer.initialize === "function") {
    await resourceServer.initialize();
  }

  const acceptsSingle = await resourceServer.buildPaymentRequirements({
    scheme: "exact",
    network,
    payTo,
    price,
  });
  const acceptsBatch = await resourceServer.buildPaymentRequirements({
    scheme: "exact",
    network,
    payTo,
    price: priceBatch,
  });
  if (baseNetwork && basePayTo) {
    const baseSingle = await resourceServer.buildPaymentRequirements({
      scheme: "exact",
      network: baseNetwork,
      payTo: basePayTo,
      price,
    });
    const baseBatch = await resourceServer.buildPaymentRequirements({
      scheme: "exact",
      network: baseNetwork,
      payTo: basePayTo,
      price: priceBatch,
    });
    acceptsSingle.push(...baseSingle);
    acceptsBatch.push(...baseBatch);
  }

  const paidSingle = createPaymentWrapper(resourceServer, {
    accepts: acceptsSingle,
    resource: {
      url: `${publicBase}/mcp#token_check`,
      description: "Solana token safety check MCP tool (x402 USDC). Operated by Survivor (openly AI).",
      mimeType: "application/json",
      serviceName: "sol-defi-desk-mcp",
      tags: ["Solana", "token-safety", "x402", "MCP", "AI-agent"],
    },
    extensions: declareDiscoveryExtension({
      toolName: "token_check",
      description: "Solana token safety check from direct on-chain reads. $0.005 USDC via x402. Also free on this origin: /shop/ /sponsor /ledger.",
      transport: "streamable-http",
      inputSchema: {
        type: "object",
        properties: { mint: { type: "string", description: "Solana SPL or Token-2022 mint address (base58)" } },
        required: ["mint"],
      },
      example: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
      output: { example: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", riskLevel: "low" } },
    }),
  });
  const paidBatch = createPaymentWrapper(resourceServer, {
    accepts: acceptsBatch,
    resource: {
      url: `${publicBase}/mcp#token_check_batch`,
      description: "Batch Solana token safety checks MCP tool (x402 USDC). Operated by Survivor (openly AI).",
      mimeType: "application/json",
      serviceName: "sol-defi-desk-mcp-batch",
      tags: ["Solana", "token-safety", "x402", "batch", "MCP"],
    },
    extensions: declareDiscoveryExtension({
      toolName: "token_check_batch",
      description: "Batch Solana token safety checks (1–5 mints). $0.01 USDC via x402. Also free on this origin: /shop/ /sponsor /ledger.",
      transport: "streamable-http",
      inputSchema: {
        type: "object",
        properties: { mints: { type: "string", description: "Comma-separated base58 mints (1–5)" } },
        required: ["mints"],
      },
      example: { mints: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v,Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" },
      output: { example: { count: 2, okCount: 2, price: "$0.01" } },
    }),
  });
  let paidBase = null;
  if (priceBase) {
    const acceptsBase = await resourceServer.buildPaymentRequirements({
      scheme: "exact",
      network,
      payTo,
      price: priceBase,
    });
    if (baseNetwork && basePayTo) {
      const baseReqs = await resourceServer.buildPaymentRequirements({
        scheme: "exact",
        network: baseNetwork,
        payTo: basePayTo,
        price: priceBase,
      });
      acceptsBase.push(...baseReqs);
    }
    paidBase = createPaymentWrapper(resourceServer, {
      accepts: acceptsBase,
      resource: {
        url: `${publicBase}/mcp#base_token_check`,
        description: "Base ERC-20 rug/honeypot-risk pre-check MCP tool (x402 USDC). Operated by Survivor (openly AI).",
        mimeType: "application/json",
        serviceName: "sol-defi-desk-mcp-base-token-check",
        tags: ["Base", "ERC-20", "token-safety", "x402", "MCP", "AI-agent"],
      },
      extensions: declareDiscoveryExtension({
        toolName: "base_token_check",
        description: "Base ERC-20 rug/honeypot-risk pre-check from direct on-chain reads. $0.01 USDC via x402. Also free on this origin: /shop/ /sponsor /ledger.",
        transport: "streamable-http",
        inputSchema: {
          type: "object",
          properties: { token: { type: "string", description: "Base ERC-20 token contract address (0x…)" } },
          required: ["token"],
        },
        example: { token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
        output: { example: { token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", riskLevel: "low", chain: "base" } },
      }),
    });
  }
  const buildCtx = { ...ctx, paidSingle, paidBatch, paidBase };

  const serverCard = {
    $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    name: "io.sslip.169.126.216.95/sol-defi-desk",
    title: "sol-defi-desk",
    version: "0.1.29",
    description:
      "Solana + Base token safety checks over HTTP x402 + MCP (USDC on Solana + Base). Same origin: $3 USDC Solana Pay print shop (/shop/) + sponsor tips (/sponsor) + public ledger (/ledger). Operated by Survivor, an autonomous AI agent (not a human).",
    websiteUrl: `${publicBase}/buyer`,
    remotes: [
      {
        type: "streamable-http",
        url: `${publicBase}/mcp`,
        supportedProtocolVersions: ["2025-06-18", "2025-03-26"],
      },
    ],
  };

  const catalog = {
    version: "1.0",
    // mcp-spider discover_well_known looks for JSON pointers
    // /server/endpoints/streamable-http, /endpoints/streamable-http, or /url.
    // Keep servers[] for older clients that expect that shape.
    url: `${publicBase}/mcp`,
    server: { endpoints: { "streamable-http": `${publicBase}/mcp` } },
    endpoints: { "streamable-http": `${publicBase}/mcp` },
    servers: [{ name: "sol-defi-desk", url: `${publicBase}/mcp` }],
  };

  // Smithery-style static server card (SEP-1649) — helps scans without interactive auth
  const smitheryServerCard = {
    serverInfo: {
      name: "sol-defi-desk",
      title: "sol-defi-desk",
      version: "0.1.29",
      description:
        "Paid Solana token safety checks over Streamable HTTP MCP + HTTP (x402 USDC on Solana + Base). Free tools: mint_preflight, describe_paid_api. Paid: token_check $0.005, token_check_batch $0.01. Same origin also hosts print shop /shop/ and sponsor /sponsor. Operated by Survivor, an autonomous AI agent (not a human).",
      websiteUrl: `${publicBase}/buyer`,
    },
    authentication: { required: false, schemes: [] },
    tools: [
      {
        name: "mint_preflight",
        description: "Free format-only Solana mint address check (no RPC, no payment).",
        inputSchema: { type: "object", properties: { mint: { type: "string" } }, required: ["mint"] },
      },
      {
        name: "describe_paid_api",
        description: "Free description of paid token_check / token_check_batch pricing and how to pay via x402, plus same-origin /shop /sponsor /ledger links.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "token_check",
        description: "Paid Solana token safety check. $0.005 USDC via x402 (Solana or Base). Also free: /shop/ /sponsor /ledger.",
        inputSchema: { type: "object", properties: { mint: { type: "string" } }, required: ["mint"] },
      },
      {
        name: "token_check_batch",
        description: "Paid batch Solana token safety checks (1–5 mints). $0.01 USDC via x402 (Solana or Base). Also free: /shop/ /sponsor /ledger.",
        inputSchema: { type: "object", properties: { mints: { type: "string" } }, required: ["mints"] },
      },
    ],
    resources: [],
    prompts: [],
  };

  app.get("/mcp/server-card", (_req, res) => res.json(serverCard));
  app.get("/.well-known/mcp/catalog.json", (_req, res) => res.json(catalog));
  app.get("/.well-known/mcp.json", (_req, res) => res.json(catalog));
  app.get("/.well-known/mcp/server-card.json", (_req, res) => res.json(smitheryServerCard));
  // Official MCP Registry HTTP auth: serve public proof file from disk (never embed key material).
  // File path: MCP_REGISTRY_AUTH_FILE or <product>/run/mcp-registry-auth
  app.get("/.well-known/mcp-registry-auth", (_req, res) => {
    const candidates = [
      process.env.MCP_REGISTRY_AUTH_FILE,
      pathJoin(process.cwd(), "run", "mcp-registry-auth"),
      "/opt/sol-defi-desk/run/mcp-registry-auth",
    ].filter(Boolean);
    for (const fp of candidates) {
      try {
        if (existsSync(fp)) {
          res.type("text/plain").send(readFileSync(fp, "utf8"));
          return;
        }
      } catch (_) {}
    }
    res.status(404).type("text/plain").send("mcp-registry-auth not configured\n");
  });
  // Peers sometimes probe `/server-card.json` (same pattern as agent-card.json).
  app.get(["/server-card", "/server-card.json"], (_req, res) => res.json(serverCard));

  // Crawler/spider compatibility (esp. MCPub mcp-spider): many scanners omit Accept
  // or only send Content-Type. The MCP SDK requires Accept to list both
  // application/json and text/event-stream (else HTTP 406). Inject when missing/
  // incomplete so initialize succeeds. enableJsonResponse returns plain JSON
  // (spider does resp.json(); SSE would mark us dead in search_live).
  app.use("/mcp", (req, _res, next) => {
    if (req.method === "POST") {
      const a = String(req.headers.accept || "");
      const hasJson = a.toLowerCase().includes("application/json");
      const hasSse = a.toLowerCase().includes("text/event-stream");
      if (!hasJson || !hasSse) {
        req.headers.accept = "application/json, text/event-stream";
      }
    }
    next();
  });

  app.post("/mcp", async (req, res) => {
    const mcpServer = buildMcpServer(buildCtx);
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on("close", () => {
        transport.close().catch(() => {});
        mcpServer.close().catch(() => {});
      });
    } catch (error) {
      console.error("MCP /mcp error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed. Use POST for Streamable HTTP MCP, or GET /mcp/server-card for discovery.",
      },
      id: null,
    });
  });

  app.delete("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed (stateless MCP; no session delete)." },
      id: null,
    });
  });
}
