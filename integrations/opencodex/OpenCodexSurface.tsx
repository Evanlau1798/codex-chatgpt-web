import { useLayoutEffect, useState } from "react";
import { Icon } from "./icons";
import { messageOf } from "./app-shared";
import type { Language } from "./types";

const copy = {
  en: { reload: "Reload OpenCodex", body: "Providers, models, accounts and updates", loading: "Loading OpenCodex…", unavailable: "The OpenCodex dashboard is unavailable. Reload it when its service is ready." },
  fr: { reload: "Recharger OpenCodex", body: "Fournisseurs, modèles, comptes et mises à jour", loading: "Chargement d’OpenCodex…", unavailable: "Le tableau de bord OpenCodex est indisponible. Recharge-le lorsque son service est prêt." },
  "zh-CN": { reload: "重新加载 OpenCodex", body: "供应商、模型、账户和更新", loading: "正在加载 OpenCodex…", unavailable: "OpenCodex 控制面板不可用。服务就绪后请重新加载。" },
  "zh-TW": { reload: "重新載入 OpenCodex", body: "供應商、模型、帳戶與更新", loading: "正在載入 OpenCodex…", unavailable: "OpenCodex 控制面板無法使用。服務就緒後請重新載入。" },
  ja: { reload: "OpenCodex を再読み込み", body: "プロバイダー、モデル、アカウント、更新", loading: "OpenCodex を読み込み中…", unavailable: "OpenCodex を利用できません。サービスの準備ができたら再読み込みしてください。" },
  ko: { reload: "OpenCodex 새로고침", body: "공급자, 모델, 계정 및 업데이트", loading: "OpenCodex 로딩 중…", unavailable: "OpenCodex 대시보드를 사용할 수 없습니다. 서비스가 준비되면 새로고침하세요." },
};

export function OpenCodexSurface({ active, language, setError }: {
  active: boolean; language: Language; setError: (message: string | null) => void;
}) {
  const text = copy[language] ?? copy.en;
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const api = window.openCodexLauncher!;
  useLayoutEffect(() => {
    if (!slot) return;
    let cancelled = false, frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = slot.getBoundingClientRect();
        void api.setSurface({ active, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } })
          .then(() => { if (!cancelled && active) { setReady(true); setFailed(false); } })
          .catch(cause => { if (!cancelled) { setFailed(true); setError(messageOf(cause).includes("dashboard is unavailable") ? text.unavailable : messageOf(cause)); } });
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(slot);
    window.addEventListener("resize", measure);
    return () => {
      cancelled = true; cancelAnimationFrame(frame); observer.disconnect();
      window.removeEventListener("resize", measure);
      void api.setSurface({ active: false }).catch(() => {});
    };
  }, [slot, active, setError, api, text]);
  const reload = async () => {
    setReady(false); setFailed(false);
    try { await api.reload(); setReady(true); }
    catch (cause) { setFailed(true); setError(messageOf(cause).includes("dashboard is unavailable") ? text.unavailable : messageOf(cause)); }
  };
  return <section className="opencodex-surface">
    <header className="opencodex-toolbar">
      <div><strong>OpenCodex</strong><span>{text.body}</span></div>
      <button className="icon-button" type="button" aria-label={text.reload} title={text.reload} onClick={() => void reload()}>
        <Icon name="reload" />
      </button>
    </header>
    <div className="opencodex-slot" ref={setSlot}>
      {!ready ? <p role="status">{failed ? text.reload : text.loading}</p> : null}
    </div>
  </section>;
}
