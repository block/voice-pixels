# Voice Pixels Pro

An AI-powered voice-controlled image editor that lets you create, edit, and segment images through natural conversation using Google's Gemini Live API.

## Features

### 🎤 Voice Control
- Real-time voice interaction with Gemini Live API
- Audio visualization showing listening/speaking states
- Automatic microphone muting during image processing

### 🎨 Image Generation & Editing
- **Generate**: Create images from text descriptions with multiple AI models (Imagen 3/4, Gemini 3 Pro Image)
- **Edit**: Modify existing images with natural language instructions
- **Segment**: Cut out objects and remove backgrounds with advanced chroma key processing
- **Reference Images**: Use any previous image as a reference for new generations

### 🖼️ Advanced Timeline Management
- Navigate through image history with voice commands ("show me the first image")
- Persistent session storage using IndexedDB
- AI-generated session names that update as you work
- Session browser with thumbnail previews
- Manual session renaming and deletion

### 🎯 Smart Features
- Automatic image analysis on upload for contextual editing
- Separate model selection for generation vs editing
- High-resolution media processing with Gemini 3 API
- Prompt display on hover showing what created each image
- One-click download or voice-activated download

### 🎭 Modern UI
- Neo-Lab aesthetic with glassmorphism and deep blacks
- Floating controls and film-strip timeline
- Responsive design with smooth animations
- Activity log with detailed error reporting

## Prerequisites

- **Node.js** (v16 or higher)
- **Gemini API Key** - Get yours at [Google AI Studio](https://ai.google.dev/gemini-api/docs/api-key)

## Setup

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd voice-pixels
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Run the development server**
   ```bash
   npm run dev
   ```

4. **Open in browser**
   - Navigate to `http://localhost:5173` (or the port shown in terminal)
   - Enter your Gemini API key when prompted
   - Grant microphone permissions when requested

## Usage

### Getting Started

1. **Start with an image** (optional)
   - Drag and drop an image onto the upload area
   - Or click to browse and select an image

2. **Start voice session**
   - Click the "Start" button
   - The AI will analyze your image (if uploaded) and greet you
   - Begin speaking naturally!

### Voice Commands Examples

**Generation:**
- "Generate a sunset over mountains"
- "Create a logo for a coffee shop"
- "Make a portrait of a robot"

**Editing:**
- "Make it more vibrant"
- "Add a rainbow in the sky"
- "Change the colors to sepia tones"

**Segmentation:**
- "Cut out the person"
- "Remove the background"
- "Isolate the main object"

**Navigation:**
- "Show me the first image"
- "Go to the previous one"
- "Use the third image as reference"

**Download:**
- "Download this image"
- "Save this one"

### Settings

Access settings via the gear icon (⚙️) to configure:
- **API Key**: Update your Gemini API key
- **Generation Model**: Choose model for creating new images (Imagen 3, Imagen 4, Gemini 3 Pro Image, etc.)
- **Editing Model**: Choose model for modifying images (Gemini 3 Pro Image recommended)

### Session Management

Click the folder icon (📁) to:
- Browse previous sessions with AI-generated names
- Load past work to continue editing
- Rename sessions manually
- Delete old sessions
- Start new sessions

## Tech Stack

- **Frontend**: React 19, TypeScript
- **AI Models**: 
  - Gemini 2.5 Flash (voice + session naming)
  - Imagen 3/4 (image generation)
  - Gemini 3 Pro Image (image editing)
- **APIs**: 
  - Gemini Live API (real-time voice)
  - Gemini API (image generation/editing)
  - Web Audio API (audio processing)
- **Storage**: IndexedDB (session persistence)
- **Styling**: Tailwind CSS via CDN
- **Build**: Vite

## Architecture

- **Audio Pipeline**: Microphone → ScriptProcessorNode → PCM conversion → Live API → Audio playback
- **Image Pipeline**: Voice command → Tool call → Model API → Canvas processing → Timeline → IndexedDB
- **Segmentation**: AI background replacement → Chroma key removal → Morphological cleanup → Transparent PNG

## Browser Support

- Modern browsers with Web Audio API support
- Chrome/Edge recommended for best performance
- Requires microphone access

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Acknowledgments

Built with [Google Gemini API](https://ai.google.dev/gemini-api/docs)
