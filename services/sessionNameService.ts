import { GoogleGenAI } from "@google/genai";

export const generateSessionName = async (prompts: string[]): Promise<string> => {
  if (prompts.length === 0) {
    return 'Untitled Session';
  }

  const apiKey = localStorage.getItem('gemini_api_key');
  if (!apiKey) {
    // Fallback to a simple name if no API key
    return prompts[0].substring(0, 50) + (prompts[0].length > 50 ? '...' : '');
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    
    // Use a fast model for name generation
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: {
        parts: [{
          text: `Based on these image generation/editing prompts, create a brief descriptive title for this creative session. The title should be 3-5 words maximum, concise and capturing the main theme or subject.

Prompts:
${prompts.join('\n')}

Return ONLY the title, nothing else.`
        }]
      }
    });

    const generatedName = response.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    
    if (generatedName && generatedName.length > 0) {
      // Clean up the name (remove quotes, limit length)
      let cleanName = generatedName.replace(/^["']|["']$/g, '').trim();
      
      // Limit to reasonable length
      if (cleanName.length > 50) {
        cleanName = cleanName.substring(0, 50) + '...';
      }
      
      return cleanName;
    }
    
    // Fallback to first prompt if generation failed
    return prompts[0].substring(0, 50) + (prompts[0].length > 50 ? '...' : '');
  } catch (error) {
    console.error('Failed to generate session name:', error);
    // Fallback to first prompt
    return prompts[0].substring(0, 50) + (prompts[0].length > 50 ? '...' : '');
  }
};

