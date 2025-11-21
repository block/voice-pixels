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
  const apiKey = localStorage.getItem('gemini_api_key');
  if (!apiKey) throw new Error("API Key missing. Please set your API key in settings.");
  
  // Use v1alpha API version for media_resolution support
  const ai = new GoogleGenAI({ apiKey, apiVersion: 'v1alpha' });
  const parts: any[] = [{ text: prompt }];

  if (referenceImageBase64) {
    parts.unshift({
      inlineData: {
        mimeType: 'image/png', // Defaulting to PNG, model is flexible
        data: cleanBase64(referenceImageBase64)
      },
      // Use high resolution for reference images (1120 tokens)
      mediaResolution: {
        level: 'media_resolution_high'
      }
    });
  }
  
  // Get selected generation model from localStorage
  const generationModel = localStorage.getItem('gemini_generation_model') || 'imagen-3.0-generate-002';
  
  const response = await ai.models.generateContent({
    model: generationModel,
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
  const apiKey = localStorage.getItem('gemini_api_key');
  if (!apiKey) throw new Error("API Key missing. Please set your API key in settings.");
  
  // Use v1alpha API version for media_resolution support
  const ai = new GoogleGenAI({ apiKey, apiVersion: 'v1alpha' });
  const rawBase64 = cleanBase64(base64Image);

  // Get selected editing model from localStorage
  const editingModel = localStorage.getItem('gemini_editing_model') || 'gemini-3-pro-image-preview';
  
  const response = await ai.models.generateContent({
    model: editingModel,
    contents: {
      parts: [
        {
          inlineData: {
            mimeType: 'image/png', 
            data: rawBase64
          },
          // Use high resolution for better editing quality (1120 tokens)
          mediaResolution: {
            level: 'media_resolution_high'
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