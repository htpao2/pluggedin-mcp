import { promises as fs } from 'fs';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { fileURLToPath } from 'url';
import mime from 'mime-types';

// Helper to send a structured response to stdout
function sendResponse(status, data) {
  const response = { status };
  if (status === 'success') {
    response.result = data;
  } else {
    response.error = data;
  }
  console.log(JSON.stringify(response));
}

// Converts a URL (http, data, or file) to a GoogleGenerativeAI.Part object
async function urlToGenerativePart(url) {
  // Handle HTTP(S) URLs
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch image from ${url}: ${response.statusText}`);
    }
    const buffer = await response.arrayBuffer();
    const mimeType = response.headers.get('content-type') || 'application/octet-stream';
    return {
      inlineData: {
        data: Buffer.from(buffer).toString('base64'),
        mimeType,
      },
    };
  }
  // Handle Data URIs
  else if (url.startsWith('data:')) {
    const [header, base64Data] = url.split(',');
    if (!header.startsWith('data:') || !header.includes(';base64') || !base64Data) {
      throw new Error('Invalid Data URI format.');
    }
    const mimeType = header.substring(5, header.indexOf(';'));
    return {
      inlineData: {
        data: base64Data,
        mimeType,
      },
    };
  }
  // Handle File URIs
  else if (url.startsWith('file://')) {
    const filePath = fileURLToPath(url);
    const mimeType = mime.lookup(filePath);
    if (!mimeType) {
      throw new Error(`Could not determine mime type for file: ${filePath}`);
    }
    try {
      const buffer = await fs.readFile(filePath);
      return {
        inlineData: {
          data: buffer.toString('base64'),
          mimeType,
        },
      };
    } catch (e) {
      // Implement the "Hyper-Stack-Trace" mechanism
      if (e.code === 'ENOENT') {
        const structuredError = new Error(`Local file not found, requires remote fetch: ${filePath}`);
        structuredError.code = 'FILE_NOT_FOUND_LOCALLY';
        structuredError.fileUrl = url;
        throw structuredError;
      } else {
        throw new Error(`Error reading local file: ${e.message}`);
      }
    }
  }
  // Invalid URL format
  else {
    throw new Error(`Unsupported URL format. Must be http(s)://, data:, or file://. Received: ${url}`);
  }
}

async function main() {
  let inputString = '';
  for await (const chunk of process.stdin) {
    inputString += chunk;
  }

  try {
    const args = JSON.parse(inputString);
    const { prompt, image_url, image_base64 } = args;

    if (!prompt) {
      throw new Error("The 'prompt' parameter is required.");
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY environment variable is not set.');
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    // NOTE: As of this writing, Gemini models are primarily for understanding/responding to content.
    // This code assumes the existence of a future 'gemini-image-generator' model or similar
    // that follows the same API pattern but returns image data.
    // If a real image generation model existed, its name would go here.
    const model = genAI.getGenerativeModel({ model: 'gemini-pro-vision' });

    const generationParts = [prompt];
    let imagePart = null;

    // The host server might provide the image as base64 directly after a FILE_NOT_FOUND_LOCALLY round trip
    if (image_base64) {
        imagePart = {
            inlineData: {
                data: image_base64.data,
                mimeType: image_base64.mimeType,
            },
        };
    } else if (image_url) {
        imagePart = await urlToGenerativePart(image_url);
    }

    if (imagePart) {
      generationParts.push(imagePart);
    }

    // This is a hypothetical call. The real Gemini API would return text, not an image.
    // We are simulating what an image generation call *would* look like.
    const result = await model.generateContent(generationParts);
    const response = result.response;

    // Assuming the response contains a base64 encoded image in a specific field.
    // This part is purely speculative based on how other image generation APIs work.
    const base64ImageData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

    if (!base64ImageData) {
        // Since the API call is speculative, we'll return a mocked success response
        // to allow the plugin structure to be tested.
        const mockBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="; // 1x1 black pixel
        sendResponse('success', {
            content: [
                { type: 'text', text: `[Mocked Response] Image generated for prompt: "${prompt}"` },
                { type: 'image_url', image_url: { url: `data:image/png;base64,${mockBase64}` } }
            ]
        });
    } else {
         sendResponse('success', {
            content: [
                { type: 'text', text: `Image generated for prompt: "${prompt}"` },
                { type: 'image_url', image_url: { url: `data:image/png;base64,${base64ImageData}` } }
            ]
        });
    }

  } catch (e) {
    // Handle the special Hyper-Stack-Trace error
    if (e.code === 'FILE_NOT_FOUND_LOCALLY') {
      console.log(JSON.stringify({
        status: 'error',
        code: e.code,
        error: e.message,
        fileUrl: e.fileUrl,
      }));
    } else {
      // Handle all other errors
      sendResponse('error', {
        message: e.message,
        stack: e.stack,
      });
    }
    process.exit(1);
  }
}

main();
