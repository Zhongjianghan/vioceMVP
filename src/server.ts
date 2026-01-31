import "dotenv/config";
import express from "express";
import path from "path";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!AUTH_TOKEN) return next();
  const token = req.header("x-auth-token");
  if (token !== AUTH_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// 静态页面
app.use(express.static(path.join(__dirname, "../public")));

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
        error: "Missing ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID"
      });
    }

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg"
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: settings?.stability ?? 0.20,
          similarity_boost: settings?.similarity_boost ?? 0.90,
          style: settings?.style ?? 0.30,
          use_speaker_boost: settings?.use_speaker_boost ?? true
        }
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({
        error: "TTS failed",
        detail: errText
      });
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Disposition", 'inline; filename="speech.mp3"');
    res.send(audioBuffer);

  } catch (err: any) {
    console.error(err);
    res.status(500).json({
      error: "TTS failed",
      detail: err?.message || String(err)
    });
  }
});
// Serve Angular build
const webRoot = path.join(__dirname, "../public");
app.use(express.static(webRoot));

// SPA fallback (must be AFTER API routes)
app.get(/^(?!\/tts).*$/, (req, res) => {
  res.sendFile(path.join(webRoot, "index.html"));
});


app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
