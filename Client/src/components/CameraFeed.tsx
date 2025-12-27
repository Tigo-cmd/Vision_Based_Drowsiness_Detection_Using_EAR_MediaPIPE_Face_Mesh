import { Video, VideoOff, Play, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../services/api';

interface CameraFeedProps {
  alertState: 'normal' | 'warning' | 'critical';
}

export function CameraFeed({ alertState }: CameraFeedProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const isMountedRef = useRef(true);
  const [status, setStatus] = useState<'loading' | 'granted' | 'denied' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [isProcessingState, setIsProcessingState] = useState(false);
  const [isDetecting, setIsDetecting] = useState(false);
  const isProcessingRef = useRef(false);

  useEffect(() => {
    isMountedRef.current = true;

    async function startCamera() {
      console.log('[Camera] Starting camera initialization...');
      if (!isMountedRef.current) return;

      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('getUserMedia is not supported in this browser');
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480 },
          audio: false
        });

        if (!isMountedRef.current) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }

        console.log('[Camera] Permission granted!');
        streamRef.current = stream;

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          console.log('[Camera] Video playing successfully!');
          setStatus('granted');
        }
      } catch (error) {
        console.error('[Camera] Error:', error);
        if (isMountedRef.current) {
          setStatus('denied');
          setErrorMsg(error instanceof Error ? error.message : String(error));
        }
      }
    }

    startCamera();

    return () => {
      console.log('[Camera] Cleaning up...');
      isMountedRef.current = false;
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    let intervalId: NodeJS.Timeout;

    async function processFrame() {
      if (!videoRef.current || !canvasRef.current || isProcessingRef.current || !isMountedRef.current || !isDetecting) {
        return;
      }

      try {
        isProcessingRef.current = true;
        setIsProcessingState(true);

        const video = videoRef.current;
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');

        if (!ctx) {
          isProcessingRef.current = false;
          setIsProcessingState(false);
          return;
        }

        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        canvas.toBlob(async (blob) => {
          if (!isMountedRef.current) return;

          if (blob && isDetecting) {
            console.log('[Detection] Sending frame to backend...');
            try {
              await api.detectFrame(blob);
            } catch (err) {
              console.error('[Detection] Backend error:', err);
            }
          }

          if (isMountedRef.current) {
            isProcessingRef.current = false;
            setIsProcessingState(false);
          }
        }, 'image/jpeg', 0.8);

      } catch (error) {
        console.error('[Detection] Local error:', error);
        if (isMountedRef.current) {
          isProcessingRef.current = false;
          setIsProcessingState(false);
        }
      }
    }

    if (status === 'granted' && isDetecting) {
      intervalId = setInterval(processFrame, 500);
    }

    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  }, [status, isDetecting]);

  const borderColors = {
    normal: 'border-emerald-400',
    warning: 'border-amber-400',
    critical: 'border-red-500',
  };

  const glowColors = {
    normal: 'shadow-emerald-500/20',
    warning: 'shadow-amber-500/30',
    critical: 'shadow-red-500/50',
  };

  return (
    <div className="bg-white rounded-xl shadow-lg overflow-hidden transition-all duration-300">
      <div className="bg-gradient-to-r from-slate-800 to-slate-700 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${status === 'granted' ? 'bg-emerald-500' : 'bg-gray-500'}`}>
              {status === 'granted' ? <Video size={20} className="text-white" /> : <VideoOff size={20} className="text-white" />}
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">Live Camera Feed</h2>
              <p className="text-xs text-gray-300">
                {status === 'loading' && 'Initializing...'}
                {status === 'granted' && (!isDetecting ? 'Detection Stopped' : (isProcessingState ? 'Analyzing Alertness...' : 'Monitoring Active'))}
                {status === 'denied' && 'Permission Denied'}
                {status === 'error' && 'Hardware Error'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {status === 'granted' && (
              <div className="flex items-center bg-slate-700/50 rounded-lg p-1 border border-slate-600">
                <button
                  onClick={() => setIsDetecting(true)}
                  disabled={isDetecting}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all ${isDetecting
                    ? 'bg-emerald-500 text-white shadow-lg shadow-emerald-500/30'
                    : 'text-gray-300 hover:text-white hover:bg-slate-600'
                    }`}
                >
                  <Play size={14} fill={isDetecting ? "currentColor" : "none"} />
                  Start
                </button>
                <div className="w-px h-4 bg-slate-600 mx-1"></div>
                <button
                  onClick={() => setIsDetecting(false)}
                  disabled={!isDetecting}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all ${!isDetecting
                    ? 'bg-red-500 text-white shadow-lg shadow-red-500/30'
                    : 'text-gray-300 hover:text-white hover:bg-slate-600'
                    }`}
                >
                  <Square size={14} fill={!isDetecting ? "currentColor" : "none"} />
                  Stop
                </button>
              </div>
            )}
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${status === 'granted' ? (isDetecting ? 'animate-pulse bg-emerald-400' : 'bg-amber-400') : 'bg-gray-400'}`}></div>
              <span className="text-sm text-gray-300">{status === 'granted' ? (isDetecting ? 'Live' : 'Standby') : 'System Offline'}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="relative bg-slate-900 aspect-video">
        <canvas ref={canvasRef} className="hidden" />
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`w-full h-full object-cover transition-opacity duration-500 ${status === 'granted' ? 'opacity-100' : 'opacity-0'}`}
        />

        {status === 'granted' && (
          <>
            <div className={`absolute inset-0 border-4 ${borderColors[alertState]} ${glowColors[alertState]} shadow-2xl transition-all duration-300 pointer-events-none`}></div>
            {isDetecting && alertState !== 'normal' && (
              <div className="absolute top-4 left-4 right-4">
                <div className={`px-4 py-3 rounded-lg backdrop-blur-md border-2 ${alertState === 'critical'
                  ? 'bg-red-500/90 border-red-300'
                  : 'bg-amber-500/90 border-amber-300'
                  } animate-pulse`}>
                  <p className="text-white font-bold text-center">
                    {alertState === 'critical' ? '⚠️ CRITICAL: Driver Drowsiness Detected' : '⚠️ Warning: Reduced Alertness'}
                  </p>
                </div>
              </div>
            )}
            {!isDetecting && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="bg-slate-900/40 backdrop-blur-sm px-6 py-3 rounded-full border border-white/10 text-white font-medium flex items-center gap-3">
                  <Play size={20} className="text-emerald-400 translate-x-0.5" />
                  Click Start to begin monitoring
                </div>
              </div>
            )}
          </>
        )}

        {status === 'denied' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-400 p-4">
            <VideoOff size={48} className="mb-4" />
            <p className="text-lg font-medium">Camera Access Required</p>
            <p className="text-sm mt-2 text-center text-red-400">{errorMsg}</p>
          </div>
        )}

        {status === 'loading' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <div className="animate-spin rounded-full h-12 w-12 border-4 border-gray-700 border-t-emerald-500"></div>
            <p className="text-gray-400 mt-4 font-medium">Initializing Vision System...</p>
          </div>
        )}
      </div>
    </div>
  );
}
