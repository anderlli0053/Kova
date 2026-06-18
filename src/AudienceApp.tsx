import { useEffect, useRef, useState } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { emit, emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { SlideRenderer } from './components/preview/SlideRenderer';
import type { Slide, AspectRatio } from './engine/types';
import type { Theme } from './engine/theme';
import { registerBundledFonts, registerCachedFont } from './engine/bundledFonts';
import './styles/global.css';

export interface PresentInitPayload {
  slides: Slide[];
  theme: Theme;
  index: number;
  aspectRatio: AspectRatio;
  docTitle?: string;
}

const SLIDE_W = 960;

export function AudienceApp() {
  const [initData, setInitData]         = useState<PresentInitPayload | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [scale, setScale]               = useState(1);
  const [laser, setLaser]               = useState<{ x: number; y: number; color: string } | null>(null);
  const slidesRef = useRef<Slide[]>([]);
  const frameRef  = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let unlistenInit:  (() => void) | undefined;
    let unlistenNav:   (() => void) | undefined;
    let unlistenExit:  (() => void) | undefined;
    let unlistenLaser: (() => void) | undefined;

    async function setup() {
      unlistenInit = await listen<PresentInitPayload>('present:init', (e) => {
        slidesRef.current = e.payload.slides;
        setInitData(e.payload);
        setCurrentIndex(e.payload.index);
      });

      unlistenNav = await listen<{ index: number }>('present:navigate', (e) => {
        setCurrentIndex(e.payload.index);
      });

      unlistenExit = await listen('present:exit', () => {
        getCurrentWindow().close();
      });

      unlistenLaser = await listen<{ x: number; y: number; active: boolean; color: string }>('present:laser', (e) => {
        const { x, y, active, color } = e.payload;
        setLaser(active ? { x, y, color: color ?? '#ff2020' } : null);
      });

      await emit('present:ready', null);
    }

    setup();
    return () => { unlistenInit?.(); unlistenNav?.(); unlistenExit?.(); unlistenLaser?.(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Register the active theme's bundled/remote fonts in *this* window's document.
  // App.tsx does this for the main window, but that document is entirely separate
  // from this one — without this, a theme using a custom font would render
  // correctly for the presenter and silently fall back to a generic font on the
  // audience-facing screen, the one piece of hardware the audience actually sees.
  useEffect(() => {
    if (initData?.theme.bundledFonts?.length) {
      registerBundledFonts(initData.theme.bundledFonts);
    }
  }, [initData?.theme.bundledFonts]);

  useEffect(() => {
    const fonts = initData?.theme.remoteFonts;
    if (!fonts?.length) return;
    for (const font of fonts) {
      invoke<string>('download_and_cache_font', { url: font.url, sha256: font.sha256 })
        .then((cachedPath) => {
          registerCachedFont(font.family, cachedPath, font.weight, font.style, font.sha256, convertFileSrc);
        })
        .catch((err) => {
          console.warn(`[kova] remote font "${font.family}" failed: ${err}`);
        });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initData?.theme.remoteFonts]);

  // Forward keyboard events to the main presenter window so navigation works
  // even when the compositor gave OS focus to the audience window instead.
  useEffect(() => {
    if (!initData) return;
    const handler = (e: KeyboardEvent) => {
      emitTo('main', 'audience:key', { key: e.key }).catch(() => {});
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [initData]);

  // Attach ResizeObserver once the frame div is in the DOM (after initData arrives).
  useEffect(() => {
    if (!frameRef.current) return;
    const obs = new ResizeObserver(([entry]) => {
      setScale(entry.contentRect.width / SLIDE_W);
    });
    obs.observe(frameRef.current);
    return () => obs.disconnect();
  }, [initData]);

  if (!initData) {
    return (
      <div style={{
        position: 'fixed', inset: 0, background: '#000',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <div style={{ color: '#2a2a2a', fontSize: 13 }}>Connecting…</div>
      </div>
    );
  }

  const slide  = slidesRef.current[currentIndex];
  const { theme, aspectRatio, docTitle } = initData;
  const total  = slidesRef.current.length;
  const slideH = Math.round(SLIDE_W * aspectRatio.h / aspectRatio.w);

  return (
    <div style={{
      position: 'fixed', inset: 0, background: '#000',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {/* Outer box constrains to the slide's aspect ratio */}
      <div style={{
        position: 'relative',
        width: `min(100vw, calc(100vh * ${aspectRatio.w} / ${aspectRatio.h}))`,
        aspectRatio: `${aspectRatio.w} / ${aspectRatio.h}`,
        overflow: 'hidden',
      }}>
        {/* frameRef measures actual rendered width; scale = actualWidth / SLIDE_W */}
        <div ref={frameRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
          {slide && (
            <>
              <div
                style={{
                  width: SLIDE_W,
                  height: slideH,
                  transform: `scale(${scale})`,
                  transformOrigin: 'top left',
                }}
              >
                <SlideRenderer
                  slide={slide}
                  theme={theme}
                  slideNumber={currentIndex + 1}
                  totalSlides={total}
                  docTitle={docTitle}
                />
              </div>
              <div
                key={currentIndex}
                style={{
                  position: 'absolute',
                  inset: 0,
                  background: '#000',
                  animation: 'pres-fadeout 0.3s ease forwards',
                  pointerEvents: 'none',
                }}
              />
              {laser && (
                <div
                  className="pres-laser-dot"
                  style={{
                    left: `${laser.x * 100}%`,
                    top: `${laser.y * 100}%`,
                    background: laser.color,
                    boxShadow: `0 0 6px 2px ${laser.color}b3, 0 0 16px 5px ${laser.color}4d`,
                  }}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
