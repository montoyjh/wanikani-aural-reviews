# Brainstorm: Improving Voice Recognition Accuracy

## Current Implementation Summary

**Speech Recognition:**
- Uses Web Speech API (`SpeechRecognition`)
- Language switches between `en-US` (meanings) and `ja-JP` (readings)
- Confidence threshold: 0.5 (50%)
- Continuous mode with 10-second timeout

**Answer Comparison (`checkAnswer`):**
1. Direct case-insensitive match
2. For readings: katakana→hiragana, kanji→hiragana (Kuroshiro), romaji→hiragana
3. Partial/substring matching

## Problem Areas

1. **Speech-to-text accuracy** - Web Speech API may transcribe incorrectly
2. **Strict comparison** - Even small transcription errors cause failures
3. **Japanese phonetics** - Similar sounds (e.g., づ/ず, じ/ぢ) may be confused
4. **English meanings** - Synonyms not recognized (e.g., "big" vs "large")

---

## Option 1: Better Speech Recognition APIs

### A. OpenAI Whisper API
- **Pros:** State-of-the-art accuracy, excellent for Japanese, handles accents well
- **Cons:** Requires API key, costs money (~$0.006/minute), adds latency
- **Implementation:** Record audio blob → send to API → get transcript

### B. Deepgram API
- **Pros:** Real-time streaming, very accurate, good Japanese support
- **Cons:** Requires API key, costs money
- **Implementation:** WebSocket streaming or REST API

### C. Amazon Transcribe (AWS)
- **Pros:** Good accuracy, supports Japanese and English, streaming available, you already have AWS
- **Cons:** Costs ~$0.024/minute (standard) or $0.006/minute (batch)
- **Streaming:** Real-time transcription via WebSocket
- **Implementation:**
  - Use `@aws-sdk/client-transcribe-streaming` for real-time
  - Or record audio → upload to S3 → batch transcribe
- **Bonus:** Can use Lambda + API Gateway to proxy requests (avoids exposing AWS credentials in browser)

### D. Azure Speech Services
- **Pros:** Good accuracy, pronunciation assessment feature (could score how well you said it)
- **Cons:** Requires Azure account, costs money

### E. Local Whisper (whisper.cpp / transformers.js)
- **Pros:** Free, runs in browser, no API calls
- **Cons:** Large model download (40MB-1.5GB), slower, higher CPU/memory usage
- **Implementation:** Use `@xenova/transformers` for browser-based Whisper

**Recommendation:** Whisper API for best accuracy, or local Whisper for free option

---

## Option 2: Smarter Answer Comparison (No API Changes)

### A. Fuzzy String Matching
Use Levenshtein distance or similar to allow small errors:
```javascript
// Allow 1-2 character differences for longer words
const distance = levenshtein(userAnswer, correctAnswer);
const threshold = Math.max(1, Math.floor(correctAnswer.length * 0.2));
if (distance <= threshold) return true;
```
- **Pros:** Free, simple, catches typos/transcription errors
- **Cons:** May be too lenient for short words

### B. Phonetic Matching for Japanese
Normalize phonetically equivalent sounds:
```javascript
// These sound the same or very similar
const normalize = (s) => s
  .replace(/づ/g, 'ず')
  .replace(/ぢ/g, 'じ')
  .replace(/を/g, 'お')
  .replace(/は/g, 'わ')  // particle only - need context
  .replace(/へ/g, 'え'); // particle only - need context
```
- **Pros:** Handles common Japanese phonetic confusions
- **Cons:** May need more sophisticated particle detection

### C. Synonym/Meaning Matching for English
Use a synonym map or word embeddings:
```javascript
const synonyms = {
  'big': ['large', 'huge', 'great'],
  'small': ['little', 'tiny', 'mini'],
  // ... or fetch from an API
};
```
- **Pros:** Accepts valid alternate meanings
- **Cons:** Maintenance burden, or API cost for embeddings

### D. Word-Level Matching
Instead of exact string match, compare word sets:
```javascript
const userWords = new Set(userAnswer.split(/\s+/));
const correctWords = new Set(correctAnswer.split(/\s+/));
const overlap = [...userWords].filter(w => correctWords.has(w));
if (overlap.length >= correctWords.size * 0.8) return true;
```
- **Pros:** "the big dog" matches "big dog"
- **Cons:** Word order ignored (may be too lenient)

**Recommendation:** Combine fuzzy matching + phonetic normalization

---

## Option 3: Hybrid Approach

### "Confirm on Low Confidence"
If confidence is between 0.5-0.8, show the transcript and ask user to confirm:
```
Did you say "かんじ"? [Yes] [No, retry]
```
- **Pros:** Catches errors before marking wrong
- **Cons:** Extra interaction, breaks flow

### "Multiple Attempts"
Allow 2-3 speech attempts before marking wrong:
- **Pros:** Natural retry behavior
- **Cons:** Slower reviews

---

## Option 4: Use Wanikani's Auxiliary Meanings/Readings

Wanikani API provides `auxiliary_meanings` and `auxiliary_readings` that include common alternatives. Currently only using `accepted_answer: true` items.

```javascript
// Also include auxiliary meanings (user synonyms, common alternatives)
if (this.currentSubject.auxiliary_meanings) {
    answers.push(...this.currentSubject.auxiliary_meanings
        .map(m => m.meaning.toLowerCase()));
}
```
- **Pros:** Free, uses official Wanikani data
- **Cons:** May not cover all transcription errors

---

## Comparison Matrix

| Option | Accuracy Gain | Cost | Complexity | Latency |
|--------|--------------|------|------------|---------|
| AWS Transcribe (streaming) | High | ~$0.024/min | Medium | Real-time |
| AWS Transcribe (batch) | High | ~$0.006/min | Medium | +1-2s |
| Whisper API | High | ~$0.006/min | Medium | +500ms |
| Local Whisper | High | Free | High | +1-3s |
| Fuzzy matching | Medium | Free | Low | None |
| Phonetic normalization | Medium | Free | Low | None |
| Synonym matching | Medium | Free/$ | Medium | None |
| Auxiliary meanings | Low-Medium | Free | Low | None |
| Confirm on low confidence | Medium | Free | Low | +user time |

---

## AWS Transcribe Implementation Options

### Option A: Direct Browser → Transcribe Streaming
- Use `@aws-sdk/client-transcribe-streaming` in browser
- Requires exposing AWS credentials (Cognito Identity Pool recommended)
- Real-time results as you speak

### Option B: Lambda + API Gateway Proxy
- Browser sends audio blob to API Gateway
- Lambda calls Transcribe and returns text
- Keeps AWS credentials server-side
- Slightly higher latency but more secure

### Option C: Hybrid - Keep Web Speech API as Fallback
- Try Web Speech API first (free, fast)
- If confidence < threshold OR user disputes, re-transcribe with AWS
- Best of both worlds: fast for clear speech, accurate for difficult cases

---

## Recommended Approach: AWS Transcribe Streaming (Japanese Focus)

Based on preferences: Direct browser streaming, focused on Japanese readings.

### Implementation Plan

**1. Set up AWS Cognito Identity Pool**
- Create unauthenticated identity pool in AWS Console
- Attach policy allowing `transcribe:StartStreamTranscription`
- Get Identity Pool ID for browser use

**2. Add AWS SDK dependency**
```bash
npm install @aws-sdk/client-transcribe-streaming @aws-sdk/credential-providers
```

**3. Create TranscribeService class**
```javascript
import { TranscribeStreamingClient, StartStreamTranscriptionCommand } from '@aws-sdk/client-transcribe-streaming';
import { fromCognitoIdentityPool } from '@aws-sdk/credential-providers';

class TranscribeService {
    constructor(identityPoolId, region = 'us-east-1') {
        this.client = new TranscribeStreamingClient({
            region,
            credentials: fromCognitoIdentityPool({
                clientConfig: { region },
                identityPoolId
            })
        });
    }

    async transcribeStream(audioStream, languageCode = 'ja-JP') {
        const command = new StartStreamTranscriptionCommand({
            LanguageCode: languageCode,
            MediaEncoding: 'pcm',
            MediaSampleRateHertz: 16000,
            AudioStream: audioStream
        });

        const response = await this.client.send(command);
        // Process response.TranscriptResultStream
    }
}
```

**4. Capture audio from microphone**
- Use `MediaRecorder` API or `AudioWorklet` to capture PCM audio
- Stream chunks to Transcribe

**5. Integration with existing code**
- Replace/augment `SpeechRecognition` with `TranscribeService`
- For Japanese readings: use AWS Transcribe
- For English meanings: could keep Web Speech API (it's decent for English)

### Quick Wins (No AWS - Do These Too)

Even with AWS Transcribe, add these for better matching:

**1. Japanese phonetic normalization:**
```javascript
normalizeJapanese(text) {
    return text
        .replace(/づ/g, 'ず')
        .replace(/ぢ/g, 'じ')
        .replace(/を/g, 'お')
        .replace(/ヅ/g, 'ズ')
        .replace(/ヂ/g, 'ジ')
        .replace(/ヲ/g, 'オ');
}
```

**2. Fuzzy matching for small errors:**
```javascript
// npm install fastest-levenshtein
import { distance } from 'fastest-levenshtein';

isCloseMatch(userAnswer, correctAnswer) {
    const d = distance(userAnswer, correctAnswer);
    const threshold = Math.max(1, Math.floor(correctAnswer.length * 0.25));
    return d <= threshold;
}
```

### Files to Modify

- `script.js` - Add TranscribeService, update recognition flow
- `package.json` - Add AWS SDK dependencies
- `vite.config.js` - May need polyfills for AWS SDK

### Cost Estimate

AWS Transcribe Streaming: ~$0.024/minute
- 100 reviews/day × 5 seconds each = ~8 minutes/day = ~$0.20/day
- Monthly: ~$6/month for heavy use

### Verification

1. Set up Cognito Identity Pool with transcribe permissions
2. Test with simple Japanese phrase
3. Compare accuracy vs Web Speech API
4. Ensure Kuroshiro conversion still works for display
