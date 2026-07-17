import QRCode from "qrcode";

export async function generateSimpleQr(
  firstName: string,
  lastName: string,
  studentId: string,
): Promise<string> {
  const content = `${firstName}.${lastName}.${studentId}`;
  return QRCode.toDataURL(content, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 300,
  });
}

export async function generateJsonQr(
  projectName: string,
  className: string,
  firstName: string,
  lastName: string,
  studentId: string,
): Promise<string> {
  const content = JSON.stringify({
    project: projectName,
    class: className,
    firstName,
    lastName,
    studentId,
  });
  return QRCode.toDataURL(content, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 300,
  });
}
