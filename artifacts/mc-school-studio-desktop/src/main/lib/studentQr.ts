import QRCode from 'qrcode'

export async function generateStudentQrCodes(input: {
  projectName: string
  className: string
  firstName: string
  lastName: string
  studentId: string
}) {
  const options = {
    errorCorrectionLevel: 'M' as const,
    margin: 2,
    width: 300,
  }
  const [simpleQr, jsonQr] = await Promise.all([
    QRCode.toDataURL(`${input.firstName}.${input.lastName}.${input.studentId}`, options),
    QRCode.toDataURL(JSON.stringify({
      project: input.projectName,
      class: input.className,
      firstName: input.firstName,
      lastName: input.lastName,
      studentId: input.studentId,
    }), options),
  ])
  return { simpleQr, jsonQr }
}
