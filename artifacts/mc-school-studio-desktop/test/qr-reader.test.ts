import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Jimp } from 'jimp'
import { readQrFromImage } from '../src/main/lib/qrReader.ts'

const qrPngBase64 = [
  'iVBORw0KGgoAAAANSUhEUgAAAPAAAADwCAYAAAA+VemSAAAAAklEQVR4AewaftIAAAauSURBVO3BgW1jSxIEwawG/Xe5bh2Y94ERKal1GZH+g6SVBklrDZLW',
  'GiStNUhaa5C01iBprUHSWoOktQZJaw2S1hokrTVIWmuQtNYgaa0XX5CEv6ItJ0k4acuTJJy05VYSTtpykoSTtjxJwo22fEIS/oq23BgkrTVIWmuQtNYgaa1B',
  '0lqDpLVefEhbfpsk3GjLSRKetOUkCSdt+W3acpKE36Qtv00S3m2QtNYgaa1B0lqDpLUGSWsNktYaJK314ock4d3a8v+iLe+WhCdtuZGEk7b8hCS8W1u+2yBp',
  'rUHSWoOktQZJaw2S1hokrfVC/ykJJ215koSTtnxCEk7acisJJ23R9xskrTVIWmuQtNYgaa1B0lqDpLVe6D+15SQJn5CEJ225kYSTtjxpy40k3GqLzgZJaw2S',
  '1hokrTVIWmuQtNYgaa0XP6Qtf0FbniThJAmf0JYbSbjVlhtt+Qlt+QsGSWsNktYaJK01SFprkLTWIGmtQdJaLz4kCX9FEk7acqstJ0m4lYSTttxqy0kSTtpy',
  'koQnbbmRhP8Hg6S1BklrDZLWGiStNUhaa5C0VvoPupaETdpykoTv1hbdGyStNUhaa5C01iBprUHSWoOktV78kCSctOUkCZ/QlpMknLTlVhJ+k7bcSsInJOGk',
  'LZ+QhJO23ErCSVtuDJLWGiStNUhaa5C01iBprUHSWi++IAknbXnSlpMknLTlN0nCk7bcaMuTJNxIwklbniThu7XlRhKetOXdkvDdBklrDZLWGiStNUhaa5C0',
  '1iBprUHSWuk//IAknLTlJAm/SVtuJeFWW24k4aQtt5Jw0pZPSMJf0ZYbg6S1BklrDZLWGiStNUhaa5C01osPScJ3a8smbbmVhJO23EjCk7bcSMJJW35CW06S',
  'cNKWkyR8t0HSWoOktQZJaw2S1hokrTVIWiv9h0tJOGnLkyTcaMtJEm615ROScKMtt5Jw0pZbSThpy40kbNKW32SQtNYgaa1B0lqDpLUGSWsNktYaJK2V/sOl',
  'JJy05a9Iwq22nCThVltuJOGkLbeScNKWkyR8Qls+IQm32vJug6S1BklrDZLWGiStNUhaa5C01osPScKTttxIwm/SlidJ+CuScNKW79aWT0jCSVtuJeGkLTcG',
  'SWsNktYaJK01SFprkLTWIGmtF1/QlltJOGnLjbZ8QhJOkvCkLTeScCsJN5LwCUn4hCSctOVJEk7aciMJT9ryboOktQZJaw2S1hokrTVIWmuQtNaLH9KWd0vC',
  'J7TlJAl/RVtuJeGkLSdJuNWW36Qt322QtNYgaa1B0lqDpLUGSWsNktYaJK2V/sMHJOET2nKShCdtuZGEv6Itt5Lwm7TlVhK+W1vebZC01iBprUHSWoOktQZJ',
  'aw2S1nrxBUk4acuTJHy3JJy05UZbbiXhVltuJOFWW06SsElb3i0JT5Jw0pYbg6S1BklrDZLWGiStNUhaa5C01osvaMtJEp605UYSbrXlJAmfkISTtny3ttxK',
  'wklbbiThSVs+IQnv1pYnSXi3QdJag6S1BklrDZLWGiStNUha68UXJOGkLU+ScKMtt5Lwbkn4hCTcasuNJDxpy40k3ErCd2vLSRJuteXdBklrDZLWGiStNUha',
  'a5C01iBprUHSWi++oC232vLd2nIjCSdteZKEG225lYSTtnxCEk7acpKEJ235hCScJGGLQdJag6S1BklrDZLWGiStNUha68UXJOGvaMtJWz4hCbfactKWkyR8',
  'QltOkvAJSThpy622nCThVhJO2nJjkLTWIGmtQdJag6S1BklrDZLWevEhbfltknAjCbfa8glJOGnLSVtOknArCSdtOUnCrbZ8t7acJOFJW95tkLTWIGmtQdJa',
  'g6S1BklrDZLWGiSt9eKHJOHd2vJXJOFWEv6KJGzRlidJOGnLjUHSWoOktQZJaw2S1hokrTVIWuuF/lNbTpLwJAknbTlpyyck4VYS3q0tn5CEW0k4actJEp60',
  '5d0GSWsNktYaJK01SFprkLTWIGmtF/pPSThpy60knLTlSRJO2nLSlpMkPGnLSRJ+k7Y8ScJJW06ScNKWJ0k4acuNQdJag6S1BklrDZLWGiStNUha68UPacsW',
  'bfluSRAk4aQtJ0m4lYSTtpwk4Ulb3m2QtNYgaa1B0lqDpLUGSWsNktYaJK314kOSoGdtOUnCJyThVhLeLQm3knCrLTeScCsJJ225MUhaa5C01iBprUHSWoOk',
  'tQZJa6X/IGmlQdJag6S1BklrDZLWGiStNUhaa5C01iBprUHSWoOktQZJaw2S1hokrfU/JbI0GN4NLUUAAAAASUVORK5CYII=',
].join('')

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'mc-school-studio-qr-'))
  const qrPath = join(root, 'marker.png')
  writeFileSync(qrPath, Buffer.from(qrPngBase64, 'base64'))
  return { root, qrPath }
}

test('reads the student reference from a generated QR marker', async () => {
  const fixture = createFixture()
  try {
    const result = await readQrFromImage(fixture.qrPath)
    assert.equal(result?.studentId, '001234')
    assert.equal(result?.firstName, 'John')
    assert.equal(result?.lastName, 'Smith')
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('reads a rotated camera QR marker', async () => {
  const fixture = createFixture()
  const rotatedPath = join(fixture.root, 'marker-rotated.jpg')
  try {
    const image = await Jimp.read(fixture.qrPath)
    await image.rotate(90).write(rotatedPath)

    const result = await readQrFromImage(rotatedPath)
    assert.equal(result?.studentId, '001234')
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})