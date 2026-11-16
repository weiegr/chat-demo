import { useTranslate } from '../../i18n/index.js'
import clsx from 'clsx'
import { memo, useLayoutEffect, useRef, useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { IconCloseFill14, IconEditOutline16, IconPaperclipOutline16 } from '../base/icons.js'
import { editMessage, retryUpload } from '../../services/chat/store.js'
import { stopReadAloud } from '../../services/speech/readAloud.js'
import type {
  FileAttachment,
  UserMessage as UserMessageType,
} from '../../services/chat/types.js'
import {
  ACCEPT,
  cancelUpload,
  isImage,
  resolveMimeType,
  uploadAttachment,
  validateFiles,
} from '../../services/attachments.js'
import { deleteFiles, saveFiles } from '../../services/chat/db.js'
import { useSettings } from '../../services/settings.js'
import { createId } from '../../utils/id.js'
import { showToast } from '../base/toastState.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { ensureApiKey } from '../settings/settingsDialogState.js'
import {
  BranchSwitcher,
  type MessageVersions,
  type SelectMessageVersion,
} from './BranchSwitcher.js'
import { MessageFile } from './MessageFile.js'
import { CopyButton } from './CopyButton.js'
import styles from './UserMessage.module.css'

export const UserMessage = memo(function UserMessage({
  sessionId,
  message,
  retryUploadId,
  isFirst,
  isLast,
  busy,
  versions,
  onSelectVersion,
}: {
  sessionId: string
  message: UserMessageType
  /** 回答因补传附件失败可重试时为该回答 id */
  retryUploadId: string | null
  isFirst: boolean
  isLast: boolean
  busy: boolean
  versions: MessageVersions
  onSelectVersion: SelectMessageVersion
}) {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.content)
  // 编辑时单独维护附件列表，移除只影响这次重新提问
  const [editFiles, setEditFiles] = useState<FileAttachment[]>(message.files)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // 本次编辑新加、已写入 IndexedDB 的附件；撤掉或取消时连带删除原件
  const addedFileIds = useRef<string[]>([])
  const isMobile = useIsMobile()
  const files = editing ? editFiles : message.files
  // 新加的附件要等上传拿到 serverId 才能发送，与输入框规则一致
  const uploading = editing && editFiles.some((file) => !file.serverId)
  const canSend = !busy && !uploading && (draft.trim() !== '' || files.length > 0)

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (editing && textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 202)}px`
    }
  }, [editing, draft])

  const sendEdit = () => {
    if (canSend && ensureApiKey() && editMessage(sessionId, message.id, draft.trim(), editFiles)) {
      addedFileIds.current = []
      stopReadAloud()
      setEditing(false)
    }
  }

  /** 删掉本次新加的原件；原消息已存在的附件不动，旧版本仍在引用 */
  const dropAddedFiles = (ids: string[]) => {
    if (ids.length === 0) {
      return
    }
    addedFileIds.current = addedFileIds.current.filter((id) => !ids.includes(id))
    void deleteFiles(ids).catch(() => undefined)
  }

  const cancelEdit = () => {
    for (const id of addedFileIds.current) {
      cancelUpload(id)
    }
    dropAddedFiles([...addedFileIds.current])
    setEditFiles(message.files)
    setEditing(false)
  }

  const addFiles = async (picked: File[]) => {
    if (picked.length === 0 || !ensureApiKey()) {
      return
    }
    const error = validateFiles(picked, editFiles.length)
    if (error) {
      showToast(error)
      return
    }
    const added = picked.map((file) => ({
      id: createId(),
      serverId: null,
      name: file.name,
      size: file.size,
      isImage: isImage(resolveMimeType(file)),
      mimeType: resolveMimeType(file),
    }))
    // 先落库再进列表，缩略图靠 IndexedDB 里的原件渲染
    await saveFiles(added.map((file, index) => ({ id: file.id, blob: picked[index] })))
    addedFileIds.current.push(...added.map((file) => file.id))
    setEditFiles((list) => [...list, ...added])
    const apiKey = useSettings.getState().apiKey ?? ''
    added.forEach((item, index) => {
      const picked0 = picked[index]
      void uploadAttachment(apiKey, item.id, picked0, item.name, item.isImage)
        .then((serverId) =>
          setEditFiles((list) =>
            list.map((file) => (file.id === item.id ? { ...file, serverId } : file))
          )
        )
        .catch(() => undefined)
    })
  }

  const removeFile = (id: string) => {
    cancelUpload(id)
    dropAddedFiles([id])
    setEditFiles((list) => list.filter((file) => file.id !== id))
  }

  return (
    <div className={clsx(styles.container, isFirst && styles.isFirst)}>
      {files.length > 0 ? (
        <div
          className={clsx(
            styles.files,
            files.some((file) => !file.isImage) && styles.filesWithDocuments
          )}
        >
          {files.map((file) => (
            <div key={file.id} className={styles.fileSlot}>
              <MessageFile
                file={file}
                onRetry={retryUploadId ? () => retryUpload(sessionId, retryUploadId) : null}
              />
              {editing ? (
                <button
                  type="button"
                  className={styles.fileRemove}
                  aria-label={t('removeAttachment')}
                  onClick={() => removeFile(file.id)}
                >
                  <IconCloseFill14 />
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {editing ? (
        <div className={styles.editor}>
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            aria-label={t('editMessage')}
            autoFocus
            rows={1}
            value={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) {
                return
              }
              if (event.key === 'Escape') {
                cancelEdit()
              } else if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !isMobile) {
                event.preventDefault()
                sendEdit()
              }
            }}
          />
          <div className={styles.editorActions}>
            <IconButton
              icon={<IconPaperclipOutline16 />}
              tooltip={t('uploadFile')}
              disabled={busy}
              onClick={() => ensureApiKey() && fileInputRef.current?.click()}
            />
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              accept={ACCEPT}
              onChange={(event) => {
                void addFiles(Array.from(event.target.files ?? []))
                event.target.value = ''
              }}
            />
            <Button size="s" variant="outlined" onClick={cancelEdit}>
              {t('cancel')}
            </Button>
            <Button size="s" disabled={!canSend} onClick={sendEdit}>
              {t('send')}
            </Button>
          </div>
        </div>
      ) : (
        <>
          {message.content ? <div className={styles.bubble}>{message.content}</div> : null}
          <div className={styles.bottom}>
            <div className={clsx(styles.actions, isLast && styles.alwaysShow)}>
              {message.content ? <CopyButton text={message.content} /> : null}
              <IconButton
                icon={<IconEditOutline16 />}
                tooltip={t('editMessage')}
                tooltipPlacement="bottom"
                disabled={busy}
                onClick={() => {
                  setDraft(message.content)
                  setEditFiles(message.files)
                  addedFileIds.current = []
                  setEditing(true)
                }}
              />
            </div>
            <BranchSwitcher versions={versions} disabled={busy} onSelect={onSelectVersion} />
          </div>
        </>
      )}
    </div>
  )
})
