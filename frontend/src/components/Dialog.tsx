import { useEffect, useRef, type ReactNode } from 'react';
import Icon from './Icon';
import { useLanguage } from '../lib/i18n';

export default function Dialog({ open, onClose, title, children, className = '', lang, closeLabel }: { open: boolean; onClose: () => void; title: string; children: ReactNode; className?: string; lang?: string; closeLabel?: string }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const { t } = useLanguage();
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return <dialog ref={dialogRef} lang={lang} className={`dialog ${className}`} onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) { const r = event.currentTarget.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) onClose(); } }} aria-label={title}><div className="dialog-heading"><h2>{title}</h2><button className="round-button" type="button" aria-label={closeLabel ?? t('close')} onClick={onClose}><Icon name="close" /></button></div>{children}</dialog>;
}
