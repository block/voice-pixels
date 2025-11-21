import { GoogleGenAI } from "@google/genai";

// Helper to clean base64 string (remove data URL prefix if present)
const cleanBase64 = (data: string) => {
  if (data.includes(',')) {
    return data.split(',')[1];
  }
  return data;
};

export const analyzeImageForContext = async (base64Image: string): Promise<string> => {
  const apiKey = localStorage.getItem('gemini_api_key');
  if (!apiKey) throw new Error("API Key missing. Please set your API key in settings.");
  
  const ai = new GoogleGenAI({ apiKey, apiVersion: 'v1alpha' });
  const rawBase64 = cleanBase64(base64Image);
  
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: {
      parts: [
        {
          inlineData: {
            mimeType: 'image/png', 
            data: rawBase64
          },
          mediaResolution: {
            level: 'media_resolution_high'
          }
        },
        { 
          text: 'Briefly describe what is in this image in 1-2 sentences. Focus on the main subject, colors, composition, and style. Be concise and descriptive.'
        }
      ]
    }
  });

  const description = response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  
  if (!description) {
    throw new Error("Failed to analyze image");
  }
  
  return description;
};

