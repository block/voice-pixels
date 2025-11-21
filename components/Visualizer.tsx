import React, { useEffect, useRef } from 'react';

interface VisualizerProps {
  isActive: boolean;
  mode: 'listening' | 'speaking' | 'idle';
}

export const Visualizer: React.FC<VisualizerProps> = ({ isActive, mode }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const updateSize = () => {
      canvas.width = container.offsetWidth * window.devicePixelRatio;
      canvas.height = container.offsetHeight * window.devicePixelRatio;
      // canvas.style.width = `${container.offsetWidth}px`;
      // canvas.style.height = `${container.offsetHeight}px`;
    };

    updateSize();
    window.addEventListener('resize', updateSize);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      const width = canvas.width;
      const height = canvas.height;
      const scale = window.devicePixelRatio;

      ctx.clearRect(0, 0, width, height);
      ctx.lineWidth = 2 * scale;
      ctx.lineCap = 'round';

      if (!isActive) {
        ctx.beginPath();
        ctx.moveTo(0, height / 2);
        ctx.lineTo(width, height / 2);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        ctx.stroke();
        return;
      }

      // Simulation
      const time = Date.now() / 300;
      
      // Colors for new theme
      // Listening: Blue (User input)
      // Speaking: White/Cyan (AI output)
      const color = mode === 'listening' ? '#60A5FA' : '#FFFFFF'; 
      
      ctx.beginPath();
      ctx.moveTo(0, height / 2);

      // More organic wave
      for (let x = 0; x < width; x += scale) {
        const normalizedX = x / width;
        // Envelope to taper edges
        const envelope = Math.sin(normalizedX * Math.PI); 
        
        const amplitude = (Math.sin(x * 0.02 + time * 2) + Math.sin(x * 0.05 - time)) * (height / 4) * envelope;
        const y = height / 2 + amplitude * (mode === 'idle' ? 0.1 : 1);
        
        ctx.lineTo(x, y);
      }
      
      ctx.strokeStyle = color;
      ctx.shadowBlur = 15 * scale;
      ctx.shadowColor = color;
      ctx.stroke();
      ctx.shadowBlur = 0;

      animationRef.current = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      window.removeEventListener('resize', updateSize);
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [isActive, mode]);

  return (
    <div ref={containerRef} className="w-full h-full flex items-center justify-center">
      <canvas 
        ref={canvasRef} 
        className="w-full h-full"
      />
    </div>
  );
};