import { GoogleGenAI } from "@google/genai";

// Helper to clean base64 string (remove data URL prefix if present)
const cleanBase64 = (data: string) => {
  if (data.includes(',')) {
    return data.split(',')[1];
  }
  return data;
};

export interface ImageGenerationConfig {
  aspectRatio?: "1:1" | "3:4" | "4:3" | "9:16" | "16:9";
  imageSize?: "1K" | "2K" | "4K";
}

export const generateImage = async (
  prompt: string, 
  referenceImageBase64?: string,
  config: ImageGenerationConfig = {}
): Promise<string> => {
  if (!process.env.API_KEY) throw new Error("API Key missing");
  
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const parts: any[] = [{ text: prompt }];

  if (referenceImageBase64) {
    parts.unshift({
      inlineData: {
        mimeType: 'image/png', // Defaulting to PNG, model is flexible
        data: cleanBase64(referenceImageBase64)
      }
    });
  }
  
  // Using 'gemini-3-pro-image-preview' (Nano Banana Pro)
  const response = await ai.models.generateContent({
    model: 'gemini-3-pro-image-preview',
    contents: {
      parts: parts
    },
    config: {
      imageConfig: {
        aspectRatio: config.aspectRatio || "16:9",
        imageSize: config.imageSize || "1K"
      }
    }
  });

  // Iterate to find the image part
  for (const part of response.candidates?.[0]?.content?.parts || []) {
    if (part.inlineData && part.inlineData.data) {
      return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
    }
  }
  
  throw new Error("No image generated");
};

export const editImage = async (
  base64Image: string, 
  instruction: string,
  config: ImageGenerationConfig = {}
): Promise<string> => {
  if (!process.env.API_KEY) throw new Error("API Key missing");
  
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const rawBase64 = cleanBase64(base64Image);

  // Using 'gemini-3-pro-image-preview' (Nano Banana Pro) for editing
  const response = await ai.models.generateContent({
    model: 'gemini-3-pro-image-preview',
    contents: {
      parts: [
        {
          inlineData: {
            mimeType: 'image/png', 
            data: rawBase64
          }
        },
        { text: instruction }
      ]
    },
    config: {
       imageConfig: {
        aspectRatio: config.aspectRatio || "16:9",
        imageSize: config.imageSize || "1K"
      }
    }
  });

  // Iterate to find the image part
  for (const part of response.candidates?.[0]?.content?.parts || []) {
    if (part.inlineData && part.inlineData.data) {
      return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
    }
  }

  throw new Error("No image edited");
};