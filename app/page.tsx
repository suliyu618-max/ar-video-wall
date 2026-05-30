"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

type VideoItem = {
  id: number;
  video_url: string;
  created_at: string;
  uploader_token: string | null;
  like_count: number | null;
  comment_count: number | null;
};

type CommentItem = {
  id: number;
  video_id: number;
  content: string;
  created_at: string;
};

export default function Home() {
  const snapContainerRef = useRef<HTMLDivElement>(null);
  const snapCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);

  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [photoURL, setPhotoURL] = useState("");
  const [photoBlob, setPhotoBlob] = useState<Blob | null>(null);
  const [uploading, setUploading] = useState(false);
  const [videos, setVideos] = useState<VideoItem[]>([]);

  const [userToken] = useState(() => {
    if (typeof window === "undefined") return "";
    const token =
      localStorage.getItem("uploader_token") || crypto.randomUUID();
    localStorage.setItem("uploader_token", token);
    return token;
  });

  const [commentOpen, setCommentOpen] = useState(false);
  const [selectedVideo, setSelectedVideo] = useState<VideoItem | null>(null);
  const [comments, setComments] = useState<CommentItem[]>([]);
  const [commentText, setCommentText] = useState("");
  const [sendingComment, setSendingComment] = useState(false);

  useEffect(() => {
    fetchVideos();
    initSnapCamera();

    return () => {
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  async function initSnapCamera() {
    try {
      if (typeof window === "undefined") return;

      const apiToken = process.env.NEXT_PUBLIC_SNAP_API_TOKEN;
      const lensId = process.env.NEXT_PUBLIC_SNAP_LENS_ID;
      const lensGroupId = process.env.NEXT_PUBLIC_SNAP_LENS_GROUP_ID;

      if (!apiToken || !lensId || !lensGroupId) {
        setCameraError("缺少 Snap Camera Kit 環境變數");
        return;
      }

      if (!snapContainerRef.current) return;

      const {
        bootstrapCameraKit,
        createMediaStreamSource,
        Transform2D,
      } = await import("@snap/camera-kit");

      const cameraKit = await bootstrapCameraKit({ apiToken });
      const session = await cameraKit.createSession();

      snapContainerRef.current.innerHTML = "";
      snapContainerRef.current.appendChild(session.output.live);

      snapCanvasRef.current = session.output.live as HTMLCanvasElement;

      session.output.live.className =
        "w-full h-full object-cover rounded-[28px] bg-black";

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 720 },
          height: { ideal: 1280 },
        },
        audio: false,
      });

      cameraStreamRef.current = stream;

      const source = createMediaStreamSource(stream, {
        transform: Transform2D.MirrorX,
        cameraType: "user",
      });

      await session.setSource(source);

      const lens = await cameraKit.lensRepository.loadLens(
        lensId,
        lensGroupId
      );

      await session.applyLens(lens);
      await session.play();

      setCameraReady(true);
      setCameraError("");
    } catch (error: unknown) {
      console.error("SNAP ERROR:", error);
      setCameraError(
        error instanceof Error ? error.message : "Snap Lens 載入失敗"
      );
    }
  }

  async function fetchVideos() {
    const { data, error } = await supabase
      .from("videos")
      .select("*")
      .order("created_at", { ascending: false });

    if (!error) setVideos(data || []);
  }

  async function fetchComments(videoId: number) {
    const { data, error } = await supabase
      .from("comments")
      .select("*")
      .eq("video_id", videoId)
      .order("created_at", { ascending: false });

    if (!error) setComments(data || []);
  }

  function takePhoto() {
    const canvas = snapCanvasRef.current;

    if (!canvas) {
      alert("相機尚未準備完成");
      return;
    }

    canvas.toBlob(
      (blob) => {
        if (!blob) {
          alert("拍照失敗");
          return;
        }

        const url = URL.createObjectURL(blob);
        setPhotoBlob(blob);
        setPhotoURL(url);
      },
      "image/png",
      1
    );
  }

  async function uploadPhoto() {
    if (!photoBlob) {
      alert("請先拍照");
      return;
    }

    setUploading(true);

    const fileName = `photo-${Date.now()}.png`;

    const { error: uploadError } = await supabase.storage
      .from("susu")
      .upload(fileName, photoBlob, {
        contentType: "image/png",
      });

    if (uploadError) {
      alert("照片上傳失敗");
      setUploading(false);
      return;
    }

    const { data } = supabase.storage.from("susu").getPublicUrl(fileName);

    const { error: insertError } = await supabase.from("videos").insert([
      {
        video_url: data.publicUrl,
        uploader_token: userToken,
        like_count: 0,
        comment_count: 0,
      },
    ]);

    setUploading(false);

    if (insertError) {
      alert("資料庫寫入失敗");
      return;
    }

    alert("照片上傳成功");
    setPhotoURL("");
    setPhotoBlob(null);
    fetchVideos();
  }

  async function likeVideo(item: VideoItem) {
    const { data: existingLike } = await supabase
      .from("likes")
      .select("*")
      .eq("video_id", item.id)
      .eq("voter_token", userToken)
      .maybeSingle();

    if (existingLike) {
      alert("你已點讚過");
      return;
    }

    const { error } = await supabase.from("likes").insert([
      {
        video_id: item.id,
        voter_token: userToken,
      },
    ]);

    if (error) {
      alert("點讚失敗");
      return;
    }

    await supabase
      .from("videos")
      .update({ like_count: (item.like_count || 0) + 1 })
      .eq("id", item.id);

    fetchVideos();
  }

  function openComments(item: VideoItem) {
    setSelectedVideo(item);
    setCommentOpen(true);
    setCommentText("");
    fetchComments(item.id);
  }

  function closeComments() {
    setCommentOpen(false);
    setSelectedVideo(null);
    setComments([]);
    setCommentText("");
  }

  async function submitComment() {
    if (!selectedVideo) return;

    const content = commentText.trim();

    if (!content) {
      alert("請輸入留言內容");
      return;
    }

    setSendingComment(true);

    const { error } = await supabase.from("comments").insert([
      {
        video_id: selectedVideo.id,
        content,
      },
    ]);

    if (error) {
      alert("留言失敗");
      setSendingComment(false);
      return;
    }

    await supabase
      .from("videos")
      .update({
        comment_count: (selectedVideo.comment_count || 0) + 1,
      })
      .eq("id", selectedVideo.id);

    setCommentText("");
    setSendingComment(false);

    await fetchComments(selectedVideo.id);
    await fetchVideos();
  }

  async function deleteVideo(item: VideoItem) {
    if (item.uploader_token !== userToken) {
      alert("只有上傳者可以刪除");
      return;
    }

    if (!confirm("確定刪除照片？")) return;

    const fileName = item.video_url.split("/").pop();

    if (fileName) {
      await supabase.storage.from("susu").remove([fileName]);
    }

    await supabase.from("videos").delete().eq("id", item.id);
    fetchVideos();
  }

  return (
    <main className="bg-black min-h-screen text-white">
      <section className="min-h-screen flex flex-col items-center justify-center gap-5 px-4 py-8 border-b border-white/10">
        <h1 className="text-3xl font-black tracking-wide text-center">
          AR Lens Photo Booth
        </h1>

        <div className="relative w-full max-w-[420px] aspect-[9/16] rounded-[28px] border border-white/20 bg-black shadow-2xl overflow-hidden">
          <div ref={snapContainerRef} className="w-full h-full" />

          {cameraReady && (
            <div className="absolute bottom-6 left-0 right-0 flex justify-center">
              <button
                onClick={takePhoto}
                className="w-20 h-20 rounded-full border-[6px] border-white bg-white/20 flex items-center justify-center shadow-2xl active:scale-95 transition"
                aria-label="拍照"
              >
                <span className="w-14 h-14 rounded-full bg-white block" />
              </button>
            </div>
          )}
        </div>

        {!cameraReady && (
          <p className="text-sm text-white/60 text-center max-w-[320px] whitespace-pre-line">
            {cameraError || "Lens 載入中，請稍候..."}
          </p>
        )}

        {photoURL && (
          <div className="w-full max-w-[420px] flex flex-col gap-3">
            <img
              src={photoURL}
              alt="拍攝預覽"
              className="w-full rounded-3xl border border-white/20"
            />

            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => {
                  setPhotoURL("");
                  setPhotoBlob(null);
                }}
                className="bg-white/10 text-white px-6 py-3 rounded-2xl font-bold border border-white/20"
              >
                重拍
              </button>

              <button
                onClick={uploadPhoto}
                disabled={uploading}
                className="bg-green-500 text-white px-6 py-3 rounded-2xl font-bold"
              >
                {uploading ? "上傳中..." : "上傳照片"}
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="flex flex-col items-center gap-10 px-3 py-8">
        {videos.length === 0 ? (
          <div className="min-h-[50vh] flex items-center justify-center text-white/50 text-lg">
            目前尚無作品
          </div>
        ) : (
          videos.map((item, index) => (
            <article
              key={item.id}
              className="w-full max-w-[430px] flex flex-col gap-3"
            >
              <img
                src={item.video_url}
                alt="參賽作品"
                className="w-full aspect-[9/16] object-cover bg-black rounded-[28px] border border-white/15 shadow-2xl"
              />

              <div className="w-full rounded-[24px] border border-white/25 bg-black/80 backdrop-blur-xl px-3 py-3 shadow-xl">
                <div className="grid grid-cols-4 divide-x divide-white/20 text-center">
                  <button
                    onClick={() => likeVideo(item)}
                    className="flex flex-col items-center justify-center gap-1 px-1"
                  >
                    <span className="text-2xl">👍</span>
                    <span className="text-sm font-bold">點讚</span>
                    <span className="text-xs text-white/60">
                      {item.like_count || 0} 個讚
                    </span>
                  </button>

                  <button
                    onClick={() => openComments(item)}
                    className="flex flex-col items-center justify-center gap-1 px-1"
                  >
                    <span className="text-2xl">💬</span>
                    <span className="text-sm font-bold">留言</span>
                    <span className="text-xs text-white/60">
                      {item.comment_count || 0} 則
                    </span>
                  </button>

                  <div className="flex flex-col items-center justify-center gap-1 px-1">
                    <span className="text-2xl">⭐</span>
                    <span className="text-sm font-bold">作品</span>
                    <span className="text-xs text-violet-300 font-bold">
                      #{videos.length - index}
                    </span>
                  </div>

                  {item.uploader_token === userToken ? (
                    <button
                      onClick={() => deleteVideo(item)}
                      className="flex flex-col items-center justify-center gap-1 px-1 text-red-100"
                    >
                      <span className="text-2xl">🗑️</span>
                      <span className="text-sm font-bold">刪除</span>
                      <span className="text-[10px] text-red-100/70">
                        上傳者
                      </span>
                    </button>
                  ) : (
                    <div className="flex flex-col items-center justify-center gap-1 px-1 opacity-45">
                      <span className="text-2xl">🔒</span>
                      <span className="text-sm font-bold">刪除</span>
                      <span className="text-[10px] text-white/50">無權限</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="w-full rounded-[22px] border border-white/20 bg-black/80 backdrop-blur-xl px-4 py-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="text-2xl">⭐</span>
                  <span className="font-bold">參賽作品</span>
                </div>

                <div className="text-right text-xs text-white/70 leading-relaxed">
                  <p>上傳日期</p>
                  <p>{new Date(item.created_at).toLocaleString()}</p>
                </div>
              </div>
            </article>
          ))
        )}
      </section>

      {commentOpen && selectedVideo && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-end sm:items-center justify-center">
          <div className="w-full max-w-[430px] max-h-[85vh] rounded-t-[28px] sm:rounded-[28px] bg-zinc-950 border border-white/15 shadow-2xl flex flex-col overflow-hidden">
            <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-black">留言</h2>
                <p className="text-xs text-white/50">
                  共 {selectedVideo.comment_count || 0} 則留言
                </p>
              </div>

              <button
                onClick={closeComments}
                className="w-10 h-10 rounded-full bg-white/10 text-xl"
              >
                ×
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-3">
              {comments.length === 0 ? (
                <p className="text-white/50 text-sm text-center py-8">
                  目前尚無留言，成為第一個留言的人吧！
                </p>
              ) : (
                comments.map((comment) => (
                  <div
                    key={comment.id}
                    className="rounded-2xl bg-white/10 border border-white/10 px-4 py-3"
                  >
                    <p className="text-sm leading-relaxed">
                      {comment.content}
                    </p>
                    <p className="text-[10px] text-white/40 mt-2">
                      {new Date(comment.created_at).toLocaleString()}
                    </p>
                  </div>
                ))
              )}
            </div>

            <div className="p-4 border-t border-white/10 flex gap-2">
              <input
                value={commentText}
                onChange={(event) => setCommentText(event.target.value)}
                placeholder="輸入留言..."
                className="flex-1 rounded-2xl bg-white/10 border border-white/10 px-4 py-3 text-sm outline-none"
              />

              <button
                onClick={submitComment}
                disabled={sendingComment}
                className="rounded-2xl bg-white text-black px-5 py-3 text-sm font-bold"
              >
                {sendingComment ? "送出中" : "送出"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}