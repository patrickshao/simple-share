"use client";

import QRCode from "qrcode";
import { useEffect, useState } from "react";

export function JoinQr({ value }: { value: string }) {
  const [image, setImage] = useState<{ value: string; url: string } | null>(null);
  const [failedValue, setFailedValue] = useState<string | null>(null);
  const imageUrl = image?.value === value ? image.url : "";

  useEffect(() => {
    let active = true;
    if (!value) {
      setImage(null);
      return;
    }

    void QRCode.toDataURL(value, {
      width: 192,
      margin: 2,
      errorCorrectionLevel: "M",
      color: {
        dark: "#13204aff",
        light: "#ffffffff",
      },
    }).then((url) => {
      if (active) { setImage({ value, url }); setFailedValue(null); }
    }).catch(() => {
      if (active) setFailedValue(value);
    });

    return () => {
      active = false;
    };
  }, [value]);

  return (
    <div className="qr-frame">
      {imageUrl ? (
        // The QR is generated locally from the short-lived join URL.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={imageUrl} width={192} height={192} alt="QR code for this private room" />
      ) : failedValue === value ? (
        <span role="status">QR unavailable. Use the room code or link instead.</span>
      ) : (
        <span className="qr-loading" role="status" aria-label="Generating QR code" />
      )}
    </div>
  );
}
