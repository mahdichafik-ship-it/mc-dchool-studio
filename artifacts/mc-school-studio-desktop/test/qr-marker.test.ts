import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  hasProcessedQrMarkerSource,
  recordQrMarker,
} from '../src/main/lib/captureRepository.ts'

type MarkerRow = {
  id: number
  projectId: number
  studentId: number
  filePath: string
  fileName: string
  sourcePath: string
  capturedAt: string
  createdAt: string
}

function createFakeDb() {
  const rows: MarkerRow[] = []
  return {
    rows,
    select() {
      return {
        from() {
          return {
            where() {
              return {
                get() {
                  return rows[0]
                },
              }
            },
          }
        },
      }
    },
    insert() {
      return {
        values(input: Omit<MarkerRow, 'id'>) {
          return {
            returning() {
              return {
                get() {
                  const row = { id: rows.length + 1, ...input }
                  rows.push(row)
                  return row
                },
              }
            },
          }
        },
      }
    },
  }
}

const marker = {
  projectId: 1,
  studentId: 7,
  filePath: '/photos/School/Class/7_Student/QR Markers/marker.jpg',
  fileName: 'marker.jpg',
  sourcePath: '/spool/marker.jpg',
  capturedAt: '2026-08-31T12:00:00.000Z',
}

test('records a QR marker once and recognizes its source after a restart', () => {
  const db = createFakeDb()
  const first = recordQrMarker(db as never, marker)
  const second = recordQrMarker(db as never, marker)

  assert.equal(first.kind, 'created')
  assert.equal(second.kind, 'duplicate')
  assert.equal(db.rows.length, 1)
  assert.equal(hasProcessedQrMarkerSource(db as never, marker.sourcePath), true)
})