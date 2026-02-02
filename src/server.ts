import "dotenv/config";
import express from "express";
import path from "path";

const app = express();
app.use(express.json({ limit: "10mb" }));

const AUTH_TOKEN = process.env.AUTH_TOKEN || "";

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!AUTH_TOKEN) return next();
  const token = req.header("x-auth-token");
  if (token !== AUTH_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ---- API ----
app.post("/tts", requireAuth, async (req, res) => {
  try {
    const { text, settings } = req.body as {
      text?: string;
      settings?: {
        stability?: number;
        similarity_boost?: number;
        style?: number;
        use_speaker_boost?: boolean;
      };
    };

    if (!text || !text.trim()) {
      return res.status(400).json({ error: "text is required" });
    }

    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID;

    if (!apiKey || !voiceId) {
      return res.status(500).json({
        error: "Missing ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID",
      });
    }

    // default WAV for lip-sync friendly output
    const format = (req.query.format as string) || "wav_22050";
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${encodeURIComponent(
      format
    )}`;

    const isWav = format.startsWith("wav_");
    const accept = isWav ? "audio/wav" : "audio/mpeg";

    // timeout safeguard
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25_000);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: accept,
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: settings?.stability ?? 0.2,
          similarity_boost: settings?.similarity_boost ?? 0.9,
          style: settings?.style ?? 0.3,
          use_speaker_boost: settings?.use_speaker_boost ?? true,
        },
      }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({
        error: "TTS failed",
        detail: errText,
      });
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());

    res.setHeader("Content-Type", accept);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="speech.${isWav ? "wav" : "mp3"}"`
    );
    // optional: help client decide extension
    res.setHeader("X-Audio-Format", format);

    res.send(audioBuffer);
  } catch (err: any) {
    console.error(err);
    res.status(500).json({
      error: "TTS failed",
      detail: err?.message || String(err),
    });
  }
});

// ---- Image Explanation with OpenAI Vision ----
app.post("/explain", requireAuth, async (req, res) => {
  try {
    const { imageBase64, mimeType } = req.body as {
      imageBase64?: string;
      mimeType?: string;
    };

    if (!imageBase64) {
      return res.status(400).json({ error: "imageBase64 is required" });
    }

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    // Use gpt-4o for best image recognition capability
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `あなたは経験豊かな大学教授です。この画像の内容を、学生に向けた簡潔な講義のように説明してください。

                      【重要な指示】
                      - 日本語で自然な会話体で説明してください
                      - 一部を口言葉にして、堅苦しくならないようにしてください
                      - 中見出し（###）、箇条書き（-）などのMarkdown記号は一切使用しないでください
                      - 普通の段落として、句点（。）で区切って自然に説明してください
                      - 最も重要なポイントのみに絞った簡潔な説明をお願いします
                      - 100〜250文字程度の自然な講義テキストを生成してください
                      - 最後に改行を3つ以上追加しないでください

                      講義内容:`,
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:${mimeType || "image/jpeg"};base64,${imageBase64}`,
                },
              },
            ],
          },
        ],
        max_tokens: 1500,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({
        error: "OpenAI API failed",
        detail: err.error?.message || "Unknown error",
      });
    }

    const data = (await response.json()) as any;
    const explanation = data.choices?.[0]?.message?.content || "No explanation generated";

    res.json({ explanation });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({
      error: "Explanation failed",
      detail: err?.message || String(err),
    });
  }
});

// ---- Cache control middleware ----
app.use((req, res, next) => {
  // HTML: never cache, always validate
  if (req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate, max-age=0');
  }
  // JS/CSS: cache for 1 hour, but revalidate
  else if (req.path.endsWith('.js') || req.path.endsWith('.css')) {
    res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
  }
  // Static assets: cache for 1 year
  else {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
  next();
});

// ---- Serve Angular build (static + SPA fallback) ----
const webRoot = path.join(__dirname, "../public");
app.use(express.static(webRoot));

// SPA fallback (must be AFTER API routes)
app.get(/^(?!\/tts|\/explain).*$/, (_req, res) => {
  res.sendFile(path.join(webRoot, "index.html"));
});

// ---- Start ----
const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`✅ Server running on http://localhost:${port}`));
