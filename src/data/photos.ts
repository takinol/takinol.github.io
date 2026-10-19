// 照片说明（便利贴）
// key = public/photos/ 里图片的文件名（不带后缀）
// value = 你想在放大照片时显示的故事/备注
// 没写说明的照片，放大时就只显示图片，不出便利贴。

export const photoNotes: Record<string, string> = {
  // 示例（可以删掉这三行）
  'sample-1': '示例照片：小猫的头像。传你自己的照片时，把 story 换成想说的话～',
  'sample-2': '示例照片：一张截图。',
  'sample-3': '示例照片：另一张截图。',
};
