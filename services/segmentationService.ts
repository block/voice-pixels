import { GoogleGenAI } from "@google/genai";

// Helper to clean base64 string (remove data URL prefix if present)
const cleanBase64 = (data: string) => {
  if (data.includes(',')) {
    return data.split(',')[1];
  }
  return data;
};

// Analyze image to determine contrasting background color
const getContrastingColor = async (base64Image: string): Promise<string> => {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const size = 100; // Sample size
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve('#00FF00'); // Default to green
        return;
      }

      // Draw scaled down version to analyze
      ctx.drawImage(img, 0, 0, size, size);
      const imageData = ctx.getImageData(0, 0, size, size);
      
      // Calculate average brightness
      let totalBrightness = 0;
      for (let i = 0; i < imageData.data.length; i += 4) {
        const r = imageData.data[i];
        const g = imageData.data[i + 1];
        const b = imageData.data[i + 2];
        totalBrightness += (r + g + b) / 3;
      }
      const avgBrightness = totalBrightness / (size * size);

      // Choose contrasting color based on brightness
      if (avgBrightness > 128) {
        resolve('#FF00FF'); // Magenta for bright images
      } else {
        resolve('#00FF00'); // Green for dark images
      }
    };
    img.onerror = () => resolve('#00FF00');
    img.src = base64Image;
  });
};

// Morphological erosion (shrink opaque regions)
const erode = (imageData: ImageData, radius: number = 1): ImageData => {
  const width = imageData.width;
  const height = imageData.height;
  const output = new ImageData(width, height);
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      
      // Check if any neighbor is transparent
      let hasTransparentNeighbor = false;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const ny = y + dy;
          const nx = x + dx;
          if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
            const nidx = (ny * width + nx) * 4;
            if (imageData.data[nidx + 3] === 0) {
              hasTransparentNeighbor = true;
              break;
            }
          }
        }
        if (hasTransparentNeighbor) break;
      }
      
      // Copy pixel data
      output.data[idx] = imageData.data[idx];
      output.data[idx + 1] = imageData.data[idx + 1];
      output.data[idx + 2] = imageData.data[idx + 2];
      
      // If has transparent neighbor, make this pixel transparent (erosion)
      if (hasTransparentNeighbor) {
        output.data[idx + 3] = 0;
      } else {
        output.data[idx + 3] = imageData.data[idx + 3];
      }
    }
  }
  
  return output;
};

// Morphological dilation (expand opaque regions)
const dilate = (imageData: ImageData, radius: number = 1): ImageData => {
  const width = imageData.width;
  const height = imageData.height;
  const output = new ImageData(width, height);
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      
      // Check if any neighbor is opaque
      let maxAlpha = imageData.data[idx + 3];
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const ny = y + dy;
          const nx = x + dx;
          if (ny >= 0 && ny < height && nx >= 0 && nx < width) {
            const nidx = (ny * width + nx) * 4;
            maxAlpha = Math.max(maxAlpha, imageData.data[nidx + 3]);
          }
        }
      }
      
      // Copy pixel data
      output.data[idx] = imageData.data[idx];
      output.data[idx + 1] = imageData.data[idx + 1];
      output.data[idx + 2] = imageData.data[idx + 2];
      output.data[idx + 3] = maxAlpha;
    }
  }
  
  return output;
};

// Remove background color from image with morphological cleanup
const removeBackgroundColor = async (
  base64Image: string,
  backgroundColor: string,
  tolerance: number = 50
): Promise<string> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Failed to get canvas context'));
        return;
      }

      ctx.drawImage(img, 0, 0);
      let imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

      // Parse background color
      const bgColor = {
        r: parseInt(backgroundColor.slice(1, 3), 16),
        g: parseInt(backgroundColor.slice(3, 5), 16),
        b: parseInt(backgroundColor.slice(5, 7), 16)
      };

      // Pass 1: Aggressive chroma key removal
      for (let i = 0; i < imageData.data.length; i += 4) {
        const r = imageData.data[i];
        const g = imageData.data[i + 1];
        const b = imageData.data[i + 2];

        // Calculate color distance
        const distance = Math.sqrt(
          Math.pow(r - bgColor.r, 2) +
          Math.pow(g - bgColor.g, 2) +
          Math.pow(b - bgColor.b, 2)
        );

        // Remove background with feathering
        if (distance < tolerance) {
          imageData.data[i + 3] = 0;
        } else if (distance < tolerance * 1.3) {
          // Feather edge
          const alpha = ((distance - tolerance) / (tolerance * 0.3)) * 255;
          imageData.data[i + 3] = Math.min(imageData.data[i + 3], alpha);
        }
      }

      // Pass 2: Erode to remove stray pixels (2 iterations)
      imageData = erode(imageData, 1);
      imageData = erode(imageData, 1);
      
      // Pass 3: Dilate to restore proper edges (2 iterations)
      imageData = dilate(imageData, 1);
      imageData = dilate(imageData, 1);

      // Pass 4: Final cleanup - remove tiny isolated regions
      const minRegionSize = 50; // Minimum pixels for a valid region
      const visited = new Set<number>();
      
      const floodFill = (startIdx: number): number => {
        const stack = [startIdx];
        let size = 0;
        const region: number[] = [];
        
        while (stack.length > 0) {
          const idx = stack.pop()!;
          if (visited.has(idx)) continue;
          
          visited.add(idx);
          const pixelIdx = idx * 4;
          
          if (imageData.data[pixelIdx + 3] === 0) continue; // Skip transparent
          
          region.push(idx);
          size++;
          
          const x = idx % canvas.width;
          const y = Math.floor(idx / canvas.width);
          
          // Check 4-connected neighbors
          if (x > 0) stack.push(idx - 1);
          if (x < canvas.width - 1) stack.push(idx + 1);
          if (y > 0) stack.push(idx - canvas.width);
          if (y < canvas.height - 1) stack.push(idx + canvas.width);
        }
        
        // If region too small, mark for removal
        if (size < minRegionSize) {
          for (const pixelIdx of region) {
            imageData.data[pixelIdx * 4 + 3] = 0;
          }
        }
        
        return size;
      };
      
      // Find and remove small regions
      for (let i = 0; i < canvas.width * canvas.height; i++) {
        if (!visited.has(i) && imageData.data[i * 4 + 3] > 0) {
          floodFill(i);
        }
      }

      ctx.putImageData(imageData, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = base64Image;
  });
};

export const segmentImage = async (
  base64Image: string, 
  instruction: string
): Promise<string> => {
  const apiKey = localStorage.getItem('gemini_api_key');
  if (!apiKey) throw new Error("API Key missing. Please set your API key in settings.");
  
  // Step 1: Determine contrasting background color
  const backgroundColor = await getContrastingColor(base64Image);
  
  // Step 2: Use editing model to place object on contrasting background
  const ai = new GoogleGenAI({ apiKey, apiVersion: 'v1alpha' });
  const rawBase64 = cleanBase64(base64Image);
  
  // Get the editing model (same as regular edits)
  const editingModel = localStorage.getItem('gemini_editing_model') || 'gemini-3-pro-image-preview';
  
  const editPrompt = `Keep only: ${instruction}. Place the object(s) on a solid ${backgroundColor} background. Remove everything else and ensure the background is completely uniform ${backgroundColor} color with no gradients or variations.`;
  
  const response = await ai.models.generateContent({
    model: editingModel,
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
        { text: editPrompt }
      ]
    },
    config: {
      imageConfig: {
        aspectRatio: "1:1",
        imageSize: "2K"
      }
    }
  });

  // Get the image with contrasting background
  let imageWithBackground: string | null = null;
  for (const part of response.candidates?.[0]?.content?.parts || []) {
    if (part.inlineData && part.inlineData.data) {
      imageWithBackground = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
      break;
    }
  }

  if (!imageWithBackground) {
    throw new Error("Failed to generate image with contrasting background");
  }

  // Step 3: Remove the background color with advanced cleanup
  const cutoutImage = await removeBackgroundColor(imageWithBackground, backgroundColor, 50);
  
  return cutoutImage;
};
