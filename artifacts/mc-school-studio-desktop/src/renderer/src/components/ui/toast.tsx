import React, { useState, useEffect, useCallback } from 'react'
import { cn } from '@/lib/utils'
import { CheckCircle, XCircle, X } from 'lucide-react'

export interface Toast {
  id: string
  type: 'success' | 'error' | 'info'
  title: string
  description?: string
}

let toastListeners: Array<(toast: Toast) => void> = []

export function addToast(toast: Omit<Toast, 'id'>) {
  const id = Math.random().toString(36).slice(2)
  toastListeners.forEach((l) => l({ ...toast, id }))
}

export function useToastState() {
  const [toasts, setToasts] = useState<Toast[]>([])

  useEffect(() => {
    const listener = (toast: Toast) => {
      setToasts((prev) => [...prev, toast])
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== toast.id))
      }, 5000)
    }
    toastListeners.push(listener)
    return () => {
      toastListeners = toastListeners.filter((l) => l !== listener)
    }
  }, [])

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  return { toasts, dismiss }
}

export function Toaster() {
  const { toasts, dismiss } = useToastState()

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-80">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            'flex items-start gap-3 rounded-lg p-4 shadow-lg border text-sm animate-in slide-in-from-bottom-5',
            {
              'bg-white border-slate-200': t.type === 'info',
              'bg-white border-green-200': t.type === 'success',
              'bg-white border-red-200': t.type === 'error',
            },
          )}
        >
          {t.type === 'success' && <CheckCircle className="size-5 text-green-500 shrink-0 mt-0.5" />}
          {t.type === 'error' && <XCircle className="size-5 text-red-500 shrink-0 mt-0.5" />}
          <div className="flex-1 min-w-0">
            <p className="font-medium text-slate-900">{t.title}</p>
            {t.description && <p className="text-slate-500 text-xs mt-0.5">{t.description}</p>}
          </div>
          <button onClick={() => dismiss(t.id)} className="text-slate-400 hover:text-slate-600 shrink-0">
            <X className="size-4" />
          </button>
        </div>
      ))}
    </div>
  )
}
