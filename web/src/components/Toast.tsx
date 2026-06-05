import { useEffect, useState } from "react";

export interface ToastController {
  show(msg: string): void;
}

export function useToast(): { node: JSX.Element; controller: ToastController } {
  const [msg, setMsg] = useState<string>("");
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!visible) return;
    const id = window.setTimeout(() => setVisible(false), 1500);
    return () => window.clearTimeout(id);
  }, [visible, msg]);

  const node = (
    <div className={"toast" + (visible ? " show" : "")} role="status" aria-live="polite">
      {msg}
    </div>
  );

  const controller: ToastController = {
    show(m: string): void {
      setMsg(m || "Saved");
      setVisible(true);
    },
  };

  return { node, controller };
}
