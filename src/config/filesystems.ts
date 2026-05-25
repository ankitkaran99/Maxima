import { env, storagePath } from '@lib/index.js'

export default {
  default: env('FILESYSTEM_DISK', 'local'),
  disks: {
    local: { driver: 'local', root: storagePath('app'), visibility: 'private' },
    public: { driver: 'local', root: storagePath('app/public'), url: `${env('APP_URL', '')}/storage`, visibility: 'public' },
    memory: { driver: 'memory' },
    null: { driver: 'null' },
    ftp: {
      driver: 'ftp',
      host: env('FTP_HOST'),
      port: env('FTP_PORT', 21),
      user: env('FTP_USERNAME'),
      password: env('FTP_PASSWORD'),
      secure: env('FTP_SECURE', false),
      url: env('FTP_URL'),
      root: env('FTP_ROOT', ''),
      visibility: 'private'
    },
    ssh: {
      driver: 'ssh',
      host: env('SFTP_HOST'),
      port: env('SFTP_PORT', 22),
      username: env('SFTP_USERNAME'),
      password: env('SFTP_PASSWORD'),
      privateKey: env('SFTP_PRIVATE_KEY'),
      passphrase: env('SFTP_PASSPHRASE'),
      url: env('SFTP_URL'),
      root: env('SFTP_ROOT', ''),
      visibility: 'private'
    },
    s3: {
      driver: 's3',
      key: env('AWS_ACCESS_KEY_ID'),
      secret: env('AWS_SECRET_ACCESS_KEY'),
      region: env('AWS_DEFAULT_REGION'),
      bucket: env('AWS_BUCKET'),
      endpoint: env('AWS_ENDPOINT'),
      usePathStyleEndpoint: env('AWS_USE_PATH_STYLE_ENDPOINT', false),
      visibility: 'private'
    }
  }
}
