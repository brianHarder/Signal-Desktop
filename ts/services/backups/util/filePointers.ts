// Copyright 2024 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from 'node:fs';
import { BackupLevel } from '@signalapp/libsignal-client/zkgroup';

import {
  APPLICATION_OCTET_STREAM,
  stringToMIMEType,
} from '../../../types/MIME';
import { createLogger } from '../../../logging/log';
import {
  type AttachmentType,
  hasRequiredInformationForBackup,
  hasRequiredInformationToDownloadFromTransitTier,
} from '../../../types/Attachment';
import { Backups, SignalService } from '../../../protobuf';
import * as Bytes from '../../../Bytes';
import {
  getSafeLongFromTimestamp,
  getTimestampFromLong,
} from '../../../util/timestampLongUtils';
import { strictAssert } from '../../../util/assert';
import type {
  CoreAttachmentBackupJobType,
  PartialAttachmentLocalBackupJobType,
} from '../../../types/AttachmentBackup';
import {
  type GetBackupCdnInfoType,
  getMediaIdFromMediaName,
  getMediaName,
} from './mediaId';
import { missingCaseError } from '../../../util/missingCaseError';
import { bytesToUuid } from '../../../util/uuidToBytes';
import { createName } from '../../../util/attachmentPath';
import { generateAttachmentKeys } from '../../../AttachmentCrypto';
import { getAttachmentLocalBackupPathFromSnapshotDir } from './localBackup';
import {
  isValidAttachmentKey,
  isValidPlaintextHash,
} from '../../../types/Crypto';

const log = createLogger('filePointers');

type ConvertFilePointerToAttachmentOptions = {
  // Only for testing
  _createName: (suffix?: string) => string;
  localBackupSnapshotDir: string | undefined;
};

export function convertFilePointerToAttachment(
  filePointer: Backups.FilePointer,
  options: Partial<ConvertFilePointerToAttachmentOptions> = {}
): AttachmentType {
  const {
    contentType,
    width,
    height,
    fileName,
    caption,
    blurHash,
    incrementalMac,
    incrementalMacChunkSize,
    locatorInfo,
  } = filePointer;
  const doCreateName = options._createName ?? createName;

  const commonProps: AttachmentType = {
    size: 0,
    contentType: contentType
      ? stringToMIMEType(contentType)
      : APPLICATION_OCTET_STREAM,
    width: width ?? undefined,
    height: height ?? undefined,
    fileName: fileName ?? undefined,
    caption: caption ?? undefined,
    blurHash: blurHash ?? undefined,
    incrementalMac: undefined,
    chunkSize: undefined,
    downloadPath: doCreateName(),
  };

  if (Bytes.isNotEmpty(incrementalMac) && incrementalMacChunkSize) {
    commonProps.incrementalMac = Bytes.toBase64(incrementalMac);
    commonProps.chunkSize = incrementalMacChunkSize;
  }

  if (locatorInfo) {
    const {
      key,
      localKey,
      legacyDigest,
      legacyMediaName,
      plaintextHash,
      encryptedDigest,
      size,
      transitCdnKey,
      transitCdnNumber,
      transitTierUploadTimestamp,
      mediaTierCdnNumber,
    } = locatorInfo;

    if (!Bytes.isNotEmpty(key)) {
      return {
        ...commonProps,
        error: true,
        size: 0,
        downloadPath: undefined,
      };
    }

    const digest = Bytes.isNotEmpty(encryptedDigest)
      ? encryptedDigest
      : legacyDigest;

    let mediaName: string | undefined;
    if (Bytes.isNotEmpty(plaintextHash) && Bytes.isNotEmpty(key)) {
      mediaName =
        getMediaName({
          key,
          plaintextHash,
        }) ?? undefined;
    } else if (legacyMediaName) {
      mediaName = legacyMediaName;
    }

    let localBackupPath: string | undefined;
    if (Bytes.isNotEmpty(localKey)) {
      const { localBackupSnapshotDir } = options;

      strictAssert(
        localBackupSnapshotDir,
        'localBackupSnapshotDir is required for filePointer.localLocator'
      );

      if (mediaName) {
        localBackupPath = getAttachmentLocalBackupPathFromSnapshotDir(
          mediaName,
          localBackupSnapshotDir
        );
      } else {
        log.error(
          'convertFilePointerToAttachment: localKey but no plaintextHash'
        );
      }
    }

    return {
      ...commonProps,
      key: Bytes.toBase64(key),
      digest: Bytes.isNotEmpty(digest) ? Bytes.toBase64(digest) : undefined,
      size: size ?? 0,
      cdnKey: transitCdnKey ?? undefined,
      cdnNumber: transitCdnNumber ?? undefined,
      uploadTimestamp: transitTierUploadTimestamp
        ? getTimestampFromLong(transitTierUploadTimestamp)
        : undefined,
      plaintextHash: Bytes.isNotEmpty(plaintextHash)
        ? Bytes.toHex(plaintextHash)
        : undefined,
      localBackupPath,
      // TODO: DESKTOP-8883
      localKey: Bytes.isNotEmpty(localKey)
        ? Bytes.toBase64(localKey)
        : undefined,
      ...(mediaName && mediaTierCdnNumber != null
        ? {
            backupCdnNumber: mediaTierCdnNumber,
          }
        : {}),
    };
  }

  return {
    ...commonProps,
    ...getAttachmentLocatorInfoFromLegacyLocators(filePointer, options),
  };
}

function getAttachmentLocatorInfoFromLegacyLocators(
  filePointer: Backups.FilePointer,
  options: Partial<ConvertFilePointerToAttachmentOptions>
) {
  const {
    attachmentLocator,
    backupLocator,
    localLocator,
    invalidAttachmentLocator,
  } = filePointer;

  if (invalidAttachmentLocator) {
    return {
      error: true,
      downloadPath: undefined,
    };
  }

  if (attachmentLocator) {
    const { cdnKey, cdnNumber, key, digest, uploadTimestamp, size } =
      attachmentLocator;
    return {
      size: size ?? 0,
      cdnKey: cdnKey ?? undefined,
      cdnNumber: cdnNumber ?? undefined,
      key: key?.length ? Bytes.toBase64(key) : undefined,
      digest: digest?.length ? Bytes.toBase64(digest) : undefined,
      uploadTimestamp: uploadTimestamp
        ? getTimestampFromLong(uploadTimestamp)
        : undefined,
    };
  }

  // These are legacy locators so the mediaName would not be correct
  if (backupLocator) {
    const {
      mediaName,
      cdnNumber,
      key,
      digest,
      size,
      transitCdnKey,
      transitCdnNumber,
    } = backupLocator;

    return {
      cdnKey: transitCdnKey ?? undefined,
      cdnNumber: transitCdnNumber ?? undefined,
      key: key?.length ? Bytes.toBase64(key) : undefined,
      digest: digest?.length ? Bytes.toBase64(digest) : undefined,
      size: size ?? 0,
      ...(mediaName && cdnNumber != null
        ? {
            backupCdnNumber: cdnNumber,
          }
        : {}),
    };
  }

  if (localLocator) {
    const {
      mediaName,
      localKey,
      remoteKey: key,
      remoteDigest: digest,
      size,
      transitCdnKey,
      transitCdnNumber,
    } = localLocator;

    const { localBackupSnapshotDir } = options;
    strictAssert(
      localBackupSnapshotDir,
      'localBackupSnapshotDir is required for filePointer.localLocator'
    );

    if (mediaName == null) {
      log.error(
        'convertFilePointerToAttachment: filePointer.localLocator missing mediaName!'
      );
      return {
        error: true,
        downloadPath: undefined,
      };
    }
    const localBackupPath = getAttachmentLocalBackupPathFromSnapshotDir(
      mediaName,
      localBackupSnapshotDir
    );

    return {
      cdnKey: transitCdnKey ?? undefined,
      cdnNumber: transitCdnNumber ?? undefined,
      key: key?.length ? Bytes.toBase64(key) : undefined,
      digest: digest?.length ? Bytes.toBase64(digest) : undefined,
      size: size ?? 0,
      localBackupPath,
      localKey: localKey?.length ? Bytes.toBase64(localKey) : undefined,
    };
  }
  return {
    error: true,
    downloadPath: undefined,
  };
}

export function convertBackupMessageAttachmentToAttachment(
  messageAttachment: Backups.IMessageAttachment,
  options: Partial<ConvertFilePointerToAttachmentOptions> = {}
): AttachmentType | null {
  const { clientUuid } = messageAttachment;

  if (!messageAttachment.pointer) {
    return null;
  }
  const result = {
    ...convertFilePointerToAttachment(messageAttachment.pointer, options),
    clientUuid: clientUuid ? bytesToUuid(clientUuid) : undefined,
  };

  switch (messageAttachment.flag) {
    case Backups.MessageAttachment.Flag.VOICE_MESSAGE:
      result.flags = SignalService.AttachmentPointer.Flags.VOICE_MESSAGE;
      break;
    case Backups.MessageAttachment.Flag.BORDERLESS:
      result.flags = SignalService.AttachmentPointer.Flags.BORDERLESS;
      break;
    case Backups.MessageAttachment.Flag.GIF:
      result.flags = SignalService.AttachmentPointer.Flags.GIF;
      break;
    case Backups.MessageAttachment.Flag.NONE:
    case null:
    case undefined:
      result.flags = undefined;
      break;
    default:
      throw missingCaseError(messageAttachment.flag);
  }

  return result;
}

export async function getFilePointerForAttachment({
  attachment,
  getBackupCdnInfo,
  backupLevel,
  messageReceivedAt,
  isLocalBackup = false,
}: {
  attachment: Readonly<AttachmentType>;
  getBackupCdnInfo: GetBackupCdnInfoType;
  backupLevel: BackupLevel;
  messageReceivedAt: number;
  isLocalBackup?: boolean;
}): Promise<{
  filePointer: Backups.FilePointer;
  backupJob?: CoreAttachmentBackupJobType | PartialAttachmentLocalBackupJobType;
}> {
  const filePointer = new Backups.FilePointer({
    contentType: attachment.contentType,
    fileName: attachment.fileName,
    width: attachment.width,
    height: attachment.height,
    caption: attachment.caption,
    blurHash: attachment.blurHash,

    // Resilience to invalid data in the database from internal testing
    ...(typeof attachment.incrementalMac === 'string' && attachment.chunkSize
      ? {
          incrementalMac: Bytes.fromBase64(attachment.incrementalMac),
          incrementalMacChunkSize: attachment.chunkSize,
        }
      : {
          incrementalMac: undefined,
          incrementalMacChunkSize: undefined,
        }),
  });

  const locatorInfo = getLocatorInfoForAttachment({
    attachment,
    isLocalBackup,
  });

  if (locatorInfo) {
    filePointer.locatorInfo = locatorInfo;
  }

  let backupJob:
    | CoreAttachmentBackupJobType
    | PartialAttachmentLocalBackupJobType
    | undefined;

  if (backupLevel !== BackupLevel.Paid && !isLocalBackup) {
    return { filePointer, backupJob: undefined };
  }

  if (!Bytes.isNotEmpty(locatorInfo.plaintextHash)) {
    return { filePointer, backupJob: undefined };
  }

  const mediaName = getMediaName({
    plaintextHash: locatorInfo.plaintextHash,
    key: locatorInfo.key,
  });

  const backupInfo = await getBackupCdnInfo(
    getMediaIdFromMediaName(mediaName).string
  );

  if (backupInfo.isInBackupTier) {
    if (locatorInfo.mediaTierCdnNumber !== backupInfo.cdnNumber) {
      log.warn(
        'backupCdnNumber on attachment differs from cdnNumber from list endpoint'
      );
      // Prefer the one from the list endpoint
      locatorInfo.mediaTierCdnNumber = backupInfo.cdnNumber;
    }
    return { filePointer, backupJob: undefined };
  }

  const { path, localKey, version, size } = attachment;

  if (!path || !isValidAttachmentKey(localKey)) {
    return { filePointer, backupJob: undefined };
  }

  if (isLocalBackup) {
    backupJob = {
      mediaName,
      type: 'local',
      data: {
        path,
        size,
        localKey,
      },
    };
  } else {
    backupJob = {
      mediaName,
      receivedAt: messageReceivedAt,
      type: 'standard',
      data: {
        path,
        localKey,
        version,
        contentType: attachment.contentType,
        keys: Bytes.toBase64(locatorInfo.key),
        size: locatorInfo.size,
        transitCdnInfo:
          locatorInfo.transitCdnKey && locatorInfo.transitCdnNumber != null
            ? {
                cdnKey: locatorInfo.transitCdnKey,
                cdnNumber: locatorInfo.transitCdnNumber,
                uploadTimestamp:
                  locatorInfo.transitTierUploadTimestamp?.toNumber(),
              }
            : undefined,
      },
    };
  }

  return { filePointer, backupJob };
}

function getLocatorInfoForAttachment({
  attachment: _rawAttachment,
  isLocalBackup,
}: {
  attachment: AttachmentType;
  isLocalBackup: boolean;
}): Backups.FilePointer.LocatorInfo {
  const locatorInfo = new Backups.FilePointer.LocatorInfo();
  const attachment = { ..._rawAttachment };

  if (attachment.error) {
    return locatorInfo;
  }

  {
    const isBackupable = hasRequiredInformationForBackup(attachment);
    const isDownloadableFromTransitTier =
      hasRequiredInformationToDownloadFromTransitTier(attachment);

    if (!isBackupable && !isDownloadableFromTransitTier) {
      // TODO: DESKTOP-8914
      if (
        isValidPlaintextHash(attachment.plaintextHash) &&
        !isValidAttachmentKey(attachment.key)
      ) {
        attachment.key = Bytes.toBase64(generateAttachmentKeys());
        // Delete all info dependent on key
        delete attachment.cdnKey;
        delete attachment.cdnNumber;
        delete attachment.uploadTimestamp;
        delete attachment.digest;
        delete attachment.backupCdnNumber;

        strictAssert(
          hasRequiredInformationForBackup(attachment),
          'should be backupable with new key'
        );
      }
    }
  }
  const isBackupable = hasRequiredInformationForBackup(attachment);
  const isDownloadableFromTransitTier =
    hasRequiredInformationToDownloadFromTransitTier(attachment);

  if (!isBackupable && !isDownloadableFromTransitTier) {
    return locatorInfo;
  }

  locatorInfo.size = attachment.size;
  locatorInfo.key = Bytes.fromBase64(attachment.key);

  if (isDownloadableFromTransitTier) {
    locatorInfo.transitCdnKey = attachment.cdnKey;
    locatorInfo.transitCdnNumber = attachment.cdnNumber;
    locatorInfo.transitTierUploadTimestamp = getSafeLongFromTimestamp(
      attachment.uploadTimestamp
    );
  }

  if (isBackupable) {
    locatorInfo.plaintextHash = Bytes.fromHex(attachment.plaintextHash);
    // TODO: DESKTOP-8887
    if (attachment.backupCdnNumber != null) {
      locatorInfo.mediaTierCdnNumber = attachment.backupCdnNumber;
    }
  } else {
    locatorInfo.encryptedDigest = Bytes.fromBase64(attachment.digest);
  }

  // TODO: DESKTOP-8904
  if (isLocalBackup && isBackupable) {
    const attachmentExistsLocally =
      attachment.path != null &&
      existsSync(
        window.Signal.Migrations.getAbsoluteAttachmentPath(attachment.path)
      );

    if (attachmentExistsLocally && attachment.localKey) {
      locatorInfo.localKey = Bytes.fromBase64(attachment.localKey);
    }
  }

  return locatorInfo;
}
