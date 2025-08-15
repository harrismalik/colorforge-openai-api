/**
 * ColorForge - Deno Deploy server
 * Single-file implementation for RapidAPI listing / demo.
 *
 * Endpoints:
 * - GET  /v1/ping
 * - POST /v1/generate    { prompt, n, size }
 * - POST /v1/edit        multipart/json { imageBase64 | imageUrl, prompt, maskBase64? }
 * - POST /v1/recolor     { imageBase64|imageUrl, colors[], preserveTexture, variations }
 * - POST /v1/visualize   { imageUrl|imageBase64, palettes[], areas?, variations }
 * - POST /v1/batch       { jobs: [{ endpoint, payload }] } -> returns jobId (demo in-memory)
 * - GET  /v1/jobs/:jobId
 * - GET  /v1/palettes    (demo curated palettes)
 *
 * Notes:
 * - This demo uses an in-memory job store (Map). Deno Deploy instances are ephemeral — use Deno KV or an external DB for production job persistence.
 * - This code assumes OpenAI endpoints: /v1/images/generations and /v1/images/edits
 */

import { serve } from "https://deno.land/std@0.192.0/http/server.ts";

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
        "authorization, x-client-info, apikey, content-type, X-OpenAI-Key, X-RapidAPI-Key, X-RapidAPI-Host",
};

// Minimal in-memory job store (demo). Replace with KV/DB for production.
type JobStatus = "queued" | "processing" | "completed" | "failed";
interface Job {
    jobId: string;
    status: JobStatus;
    result?: any;
    createdAt: string;
    error?: string;
}
const JOBS = new Map<string, Job>();

function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
}

function randId(prefix = "") {
    return prefix + crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

async function fetchAsBase64(url: string) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Failed to fetch image: ${r.status}`);
    const ab = await r.arrayBuffer();
    const b64 = btoa(String.fromCharCode(...new Uint8Array(ab)));
    const ct = r.headers.get("content-type") || "image/png";
    return `data:${ct};base64,${b64}`;
}

function stripDataPrefix(b64: string) {
    if (!b64) return b64;
    return b64.includes(",") ? b64.split(",")[1] : b64;
}

async function base64ToBlob(b64: string, filename = "image.png") {
    const payload = stripDataPrefix(b64);
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: "image/png" });
    return { blob, filename };
}

async function callOpenAIImagesGeneration(
    apiKey: string,
    prompt: string,
    size = "1024x1024",
    n = 1,
) {
    const body = {
        prompt,
        model: "gpt-image-1",
        size,
        n,
        response_format: "b64_json",
    };
    const resp = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });
    if (!resp.ok) {
        const t = await resp.text();
        throw new Error(`OpenAI generation failed: ${resp.status} ${t}`);
    }
    return resp.json();
}

async function callOpenAIImagesEdit(
    apiKey: string,
    imageBlob: Blob,
    prompt: string,
    maskBlob?: Blob | null,
    size = "1024x1024",
) {
    const fd = new FormData();
    fd.append("image", imageBlob, "image.png");
    if (maskBlob) fd.append("mask", maskBlob, "mask.png");
    fd.append("prompt", prompt);
    fd.append("model", "gpt-image-1");
    fd.append("size", size);

    const resp = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: fd,
    });
    if (!resp.ok) {
        const t = await resp.text();
        throw new Error(`OpenAI edit failed: ${resp.status} ${t}`);
    }
    return resp.json();
}

async function handleGenerate(req: Request, body: any, openaiKey: string) {
    const prompt = body.prompt || "A colorful abstract painting";
    const size = body.size || "1024x1024";
    const n = body.n || 1;

    const apiResp = await callOpenAIImagesGeneration(openaiKey, prompt, size, n);
    const results: any[] = [];
    for (const item of apiResp.data || []) {
        if (item.b64_json) {
            results.push({ image: `data:image/png;base64,${item.b64_json}`, meta: item });
        } else if (item.url) {
            results.push({ image: await fetchAsBase64(item.url), meta: item });
        }
    }
    return jsonResponse({ success: true, results });
}

async function handleEdit(req: Request, body: any, openaiKey: string) {
    // Accept either imageBase64 or imageUrl and optional maskBase64
    let imageBlob: Blob;
    if (body.imageBase64) {
        const { blob } = await base64ToBlob(body.imageBase64);
        imageBlob = blob;
    } else if (body.imageUrl) {
        const fetched = await fetch(body.imageUrl);
        if (!fetched.ok) throw new Error("Failed to fetch imageUrl");
        imageBlob = await fetched.blob();
    } else {
        return jsonResponse({ success: false, error: "imageBase64 or imageUrl required" }, 400);
    }

    let maskBlob: Blob | null = null;
    if (body.maskBase64) {
        const { blob } = await base64ToBlob(body.maskBase64);
        maskBlob = blob;
    }

    const prompt = body.prompt || "Edit the image as requested.";
    const resp = await callOpenAIImagesEdit(openaiKey, imageBlob, prompt, maskBlob, body.size);
    const item = resp.data?.[0];
    let out: string;
    if (item?.b64_json) out = `data:image/png;base64,${item.b64_json}`;
    else if (item?.url) out = await fetchAsBase64(item.url);
    else throw new Error("OpenAI returned no image");
    return jsonResponse({ success: true, result: { image: out, meta: resp } });
}

async function handleRecolor(req: Request, body: any, openaiKey: string) {
    /**
     * Generic recolor:
     * - If colors[] provided, create variations by prompting the edit endpoint per color
     * - If no mask provided, rely on model prompt to recolor main object
     *
     * Note: for best results, provide a maskBase64 or pre-segmented image. This api keeps it generic.
     */
    const colors: string[] = Array.isArray(body.colors) && body.colors.length > 0
        ? body.colors
        : ["#f0e68c", "#ffffff", "#dcdcdc", "#b0c4de"];

    const imageSource = body.imageBase64 ? "base64" : body.imageUrl ? "url" : null;
    if (!imageSource) return jsonResponse({ error: "imageBase64 or imageUrl required" }, 400);

    // Fetch image blob once, reuse
    let imageBlob: Blob;
    if (imageSource === "base64") {
        const { blob } = await base64ToBlob(body.imageBase64);
        imageBlob = blob;
    } else {
        const fetched = await fetch(body.imageUrl);
        if (!fetched.ok) throw new Error("Failed to fetch imageUrl");
        imageBlob = await fetched.blob();
    }

    // Build variations
    const variations = body.variations && Number.isInteger(body.variations) ? body.variations : colors.length;
    const preserve = body.preserveTexture !== undefined ? body.preserveTexture : true;

    const results: any[] = [];
    for (let i = 0; i < variations; i++) {
        const color = colors[i % colors.length];
        const prompt = `Change the color of the primary object(s) in the image to ${color}. Preserve texture and lighting and avoid changing glass or chrome. Keep a natural look.`;
        const resp = await callOpenAIImagesEdit(openaiKey, imageBlob, prompt, undefined, body.size);
        const item = resp.data?.[0];
        let out: string;
        if (item?.b64_json) out = `data:image/png;base64,${item.b64_json}`;
        else if (item?.url) out = await fetchAsBase64(item.url);
        else throw new Error("OpenAI returned no image for variation");
        results.push({ color, image: out, meta: resp });
    }
    return jsonResponse({ success: true, results });
}

async function handleVisualize(req: Request, body: any, openaiKey: string) {
    /**
     * Convenience wrapper:
     * - Accepts palettes[] and produces N variations
     * - This demo does not perform heavy segmentation; it's a chain of recolor edits.
     * - For production: run a segmentation model first to get masks then apply edits only to masks.
     */
    const palettes: string[] = Array.isArray(body.palettes) && body.palettes.length > 0
        ? body.palettes
        : ["#f0e68c", "#8b4513", "#ffffff", "#c0d6e4"];

    const imageSource = body.imageBase64 ? "base64" : body.imageUrl ? "url" : null;
    if (!imageSource) return jsonResponse({ error: "imageBase64 or imageUrl required" }, 400);

    let imageBlob: Blob;
    if (imageSource === "base64") {
        const { blob } = await base64ToBlob(body.imageBase64);
        imageBlob = blob;
    } else {
        const fetched = await fetch(body.imageUrl);
        if (!fetched.ok) throw new Error("Failed to fetch imageUrl");
        imageBlob = await fetched.blob();
    }

    const variations = body.variations && Number.isInteger(body.variations) ? body.variations : Math.min(6, palettes.length);
    const results: any[] = [];
    for (let i = 0; i < variations; i++) {
        const color = palettes[i % palettes.length];
        // areas parameter can influence prompt (e.g., "walls","trim") but we keep generic
        const areas = Array.isArray(body.areas) ? body.areas.join(", ") : "main surfaces";
        const prompt = `Apply the color ${color} to ${areas} in the image. Preserve texture and shadows. Keep other elements unchanged.`;
        const resp = await callOpenAIImagesEdit(openaiKey, imageBlob, prompt, undefined, body.size);
        const item = resp.data?.[0];
        let out: string;
        if (item?.b64_json) out = `data:image/png;base64,${item.b64_json}`;
        else if (item?.url) out = await fetchAsBase64(item.url);
        else throw new Error("OpenAI returned no image for visualize variation");
        // Add optional paint estimate stub (demo)
        const paintEstimate = body.estimatePaint ? { gallons: Math.max(1, Math.round((body.squareFeet || 1000) / 300)), units: "gallons" } : undefined;
        results.push({ color, image: out, paintEstimate, meta: resp });
    }
    return jsonResponse({ success: true, variations: results });
}

async function handleBatch(req: Request, body: any) {
    // Demo: accept batch and queue a job; we process immediately (synchronously) for demo.
    const jobs = Array.isArray(body.jobs) ? body.jobs : [];
    if (jobs.length === 0) return jsonResponse({ error: "jobs array required" }, 400);
    const jobId = randId("job_");
    const createdAt = new Date().toISOString();
    JOBS.set(jobId, { jobId, status: "queued", createdAt });
    // For demo: process immediately (not real async)
    (async () => {
        const job = JOBS.get(jobId);
        if (!job) return;
        job.status = "processing";
        try {
            const results = [];
            for (const j of jobs) {
                // naive dispatch: call internal endpoint handlers
                if (j.endpoint === "/v1/palettes") results.push({ endpoint: j.endpoint, result: demoPalettes() });
                else results.push({ endpoint: j.endpoint, result: "noop: not implemented in batch demo" });
            }
            job.status = "completed";
            job.result = results;
            JOBS.set(jobId, job);
        } catch (err) {
            job.status = "failed";
            job.error = String(err);
            JOBS.set(jobId, job);
        }
    })();
    return jsonResponse({ jobId, status: "queued" }, 202);
}

function demoPalettes() {
    return [
        { id: "warm-1", name: "Warm Neutrals", brand: "demo", colors: ["#f0e68c", "#d2b48c", "#8b4513"] },
        { id: "modern-1", name: "Modern Blues", brand: "demo", colors: ["#c0d6e4", "#90a4b2", "#2f4f4f"] },
    ];
}

async function handlePalettes(req: Request, query: URLSearchParams) {
    const brand = query.get("brand");
    const all = demoPalettes();
    if (brand) {
        return jsonResponse({ palettes: all.filter((p) => p.brand === brand) });
    }
    return jsonResponse({ palettes: all });
}

serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response(null, { headers: CORS_HEADERS });
    }
    try {
        const url = new URL(req.url);
        if (url.pathname === "/docs" && req.method === "GET") {
            const html = await Deno.readTextFile("../docs.html");
            return new Response(html, {
                status: 200,
                headers: {
                    "Content-Type": "text/html",
                    ...CORS_HEADERS,
                },
            });
        }
        if (url.pathname === "/v1/ping" && req.method === "GET") {
            return jsonResponse({ status: "ok", time: new Date().toISOString() });
        }
        if (url.pathname === "/v1/palettes" && req.method === "GET") {
            return await handlePalettes(req, url.searchParams);
        }
        if (url.pathname === "/v1/batch" && req.method === "POST") {
            const body = await req.json().catch(() => ({}));
            return await handleBatch(req, body);
        }
        if (url.pathname.startsWith("/v1/jobs/") && req.method === "GET") {
            const jobId = url.pathname.split("/").pop()!;
            const job = JOBS.get(jobId);
            if (!job) return jsonResponse({ error: "job not found" }, 404);
            return jsonResponse(job);
        }

        // NOTE: RapidAPI injects X-RapidAPI-Key and X-RapidAPI-Host headers; we allow them but do not require them here.
        // Prefer X-OpenAI-Key header check
        const OPENAI_KEY = req.headers.get("X-OpenAI-Key") || req.headers.get("x-openai-key");
        if (!OPENAI_KEY) {
            return jsonResponse({ error: "X-OpenAI-Key: Required" }, 500);
        }

        // Route dispatch
        if (url.pathname === "/v1/generate" && req.method === "POST") {
            const body = await req.json().catch(() => ({}));
            return await handleGenerate(req, body, OPENAI_KEY);
        }
        if (url.pathname === "/v1/edit" && req.method === "POST") {
            const body = await req.json().catch(() => ({}));
            return await handleEdit(req, body, OPENAI_KEY);
        }
        if (url.pathname === "/v1/recolor" && req.method === "POST") {
            const body = await req.json().catch(() => ({}));
            return await handleRecolor(req, body, OPENAI_KEY);
        }
        if (url.pathname === "/v1/visualize" && req.method === "POST") {
            const body = await req.json().catch(() => ({}));
            return await handleVisualize(req, body, OPENAI_KEY);
        }

        return jsonResponse({ error: "Not found" }, 404);
    } catch (err) {
        return jsonResponse({ error: err.message || String(err), stack: err.stack }, 500);
    }
});
