// SPDX-License-Identifier: GPL-3.0-or-later
// ENW Zombies: a T4 (World at War) GfxWorld dumper for OpenAssetTools (GPL-3.0).
//
// WHY. OAT's T4 zone loader already deserialises GfxWorld out of a map fastfile, but OAT
// has no writer for it (docs/SupportedAssetTypes.md: GfxWorld dump/load both unsupported).
// Before this, the only way to a WaW world shell was Husky reading the RUNNING game's
// memory -- one game launch per map (docs/kickstart/replay.md section 4, 16). This dumper
// makes the shell an offline, file-only step: `Unlinker --include-assets gfxworld <map>.ff`.
//
// WHAT IT WRITES (both under <out>/world/):
//   <bsp>.bin   vertexCount x 8 float32 (x y z  nx ny nz  u v), then indexCount x uint16
//   <bsp>.json  counts, bounds, every surface (material, first vertex, base index, tri
//               count, brush model it belongs to), the material table (colour-map image
//               per material), every static model placement (smodelDrawInsts: model,
//               origin, 3x3 axis, scale) and the brush model table.
// Positions are raw engine units (inches), Z up -- the frame the replay is recorded in.
// Nothing is scaled or rotated. UVs are the engine's (top-left origin), as glTF wants.
//
// A surface's triangle k is  firstVertex + indices[baseIndex + 3k + {0,1,2}]  (srfTriangles_t).
#include "GfxWorldDumperT4.h"

#include <algorithm>
#include <cmath>
#include <format>
#include <iomanip>
#include <nlohmann/json.hpp>
#include <string>
#include <unordered_map>
#include <vector>

using namespace T4;
using namespace nlohmann;

namespace
{
    std::string CleanImageName(const char* name)
    {
        if (!name)
            return {};
        std::string s(name);
        while (!s.empty() && (s.front() == ',' || s.front() == '*'))
            s.erase(s.begin());
        return s;
    }

    // Same preference order as OAT's XModelToCommonConverter GetMaterialColorMap for T4.
    const GfxImage* ColorMapOf(const Material* material)
    {
        if (!material || !material->textureTable)
            return nullptr;
        std::vector<const MaterialTextureDef*> c;
        for (auto i = 0u; i < material->textureCount; i++)
            if (material->textureTable[i].semantic == TS_COLOR_MAP)
                c.push_back(&material->textureTable[i]);
        if (c.empty())
            return nullptr;
        for (const auto* d : c)
            if (tolower(d->nameStart) == 'c' && tolower(d->nameEnd) == 'p')
                return d->u.image;
        for (const auto* d : c)
            if (tolower(d->nameStart) == 'r' && tolower(d->nameEnd) == 'k')
                return d->u.image;
        for (const auto* d : c)
            if (tolower(d->nameStart) == 'd' && tolower(d->nameEnd) == 'p')
                return d->u.image;
        return c[0]->u.image;
    }

    // IW3/T4 PackedUnitVec: scale = (w + 192) / 32385, v = (b - 127) * scale; normalised after.
    void UnpackUnitVec(const PackedUnitVec& p, float* out)
    {
        const float scale = (static_cast<float>(p.array[3]) + 192.0f) / 32385.0f;
        float len = 0;
        for (int i = 0; i < 3; i++)
        {
            out[i] = (static_cast<float>(p.array[i]) - 127.0f) * scale;
            len += out[i] * out[i];
        }
        len = std::sqrt(len);
        if (len > 1e-6f)
            for (int i = 0; i < 3; i++)
                out[i] /= len;
        else
        {
            out[0] = out[1] = 0;
            out[2] = 1;
        }
    }

    std::string BaseName(const std::string& assetName)
    {
        // "maps/nazi_zombie_prototype.d3dbsp" -> "nazi_zombie_prototype"
        auto s = assetName;
        const auto slash = s.find_last_of("/\\");
        if (slash != std::string::npos)
            s = s.substr(slash + 1);
        const auto dot = s.find('.');
        if (dot != std::string::npos)
            s = s.substr(0, dot);
        return s;
    }
} // namespace

namespace gfx_world
{
    void DumperT4::DumpAsset(AssetDumpingContext& context, const XAssetInfo<GfxWorld>& asset)
    {
        const auto* world = asset.Asset();
        if (!world)
            return;
        const auto bsp = BaseName(asset.m_name);

        const auto vertexCount = world->vd.vertices ? world->vertexCount : 0u;
        const auto indexCount = world->indices ? static_cast<unsigned>(std::max(world->indexCount, 0)) : 0u;

        // ---- geometry -------------------------------------------------------------------
        {
            const auto bin = context.OpenAssetFile(std::format("world/{}.bin", bsp));
            if (!bin)
                return;
            std::vector<float> row(8);
            for (auto i = 0u; i < vertexCount; i++)
            {
                const auto& v = world->vd.vertices[i];
                row[0] = v.xyz[0];
                row[1] = v.xyz[1];
                row[2] = v.xyz[2];
                UnpackUnitVec(v.normal, &row[3]);
                row[6] = v.texCoord[0];
                row[7] = v.texCoord[1];
                bin->write(reinterpret_cast<const char*>(row.data()), sizeof(float) * 8);
            }
            if (indexCount)
                bin->write(reinterpret_cast<const char*>(world->indices), sizeof(uint16_t) * indexCount);
        }

        // ---- which brush model owns each surface (model 0 is the world itself) ----------
        const auto surfaceCount = world->dpvs.surfaces ? static_cast<unsigned>(std::max(world->surfaceCount, 0)) : 0u;
        std::vector<int> owner(surfaceCount, -1);
        json jModels = json::array();
        for (auto m = 0; world->models && m < world->modelCount; m++)
        {
            const auto& bm = world->models[m];
            jModels.push_back({
                {"index",           m                                                                        },
                {"startSurf",       bm.startSurfIndex                                                        },
                {"surfaceCount",    bm.surfaceCount                                                          },
                {"mins",            {bm.bounds[0][0], bm.bounds[0][1], bm.bounds[0][2]}                      },
                {"maxs",            {bm.bounds[1][0], bm.bounds[1][1], bm.bounds[1][2]}                      },
            });
            if (m == 0)
                continue;
            for (auto s = bm.startSurfIndex; s < bm.startSurfIndex + bm.surfaceCount && s < surfaceCount; s++)
                owner[s] = m;
        }

        // ---- surfaces + material table ---------------------------------------------------
        std::unordered_map<const Material*, size_t> matIndex;
        json jMats = json::array();
        json jSurfs = json::array();
        for (auto s = 0u; s < surfaceCount; s++)
        {
            const auto& surf = world->dpvs.surfaces[s];
            size_t mi = 0;
            const auto found = matIndex.find(surf.material);
            if (found == matIndex.end())
            {
                mi = jMats.size();
                matIndex.emplace(surf.material, mi);
                const auto* mat = surf.material;
                const auto* cm = ColorMapOf(mat);
                jMats.push_back({
                    {"name",      mat && mat->info.name ? mat->info.name : ""                                   },
                    {"colorMap",  cm ? CleanImageName(cm->name) : ""                                             },
                    {"technique", mat && mat->techniqueSet && mat->techniqueSet->name ? mat->techniqueSet->name : ""},
                    {"sortKey",   mat ? mat->info.sortKey : 0                                                    },
                    {"gameFlags", mat ? mat->info.gameFlags : 0                                                  },
                    {"surfaceTypeBits", mat ? mat->info.surfaceTypeBits : 0u                                     },
                });
            }
            else
                mi = found->second;

            jSurfs.push_back({
                surf.tris.firstVertex,
                surf.tris.vertexCount,
                surf.tris.baseIndex,
                surf.tris.triCount,
                mi,
                owner[s],
                static_cast<int>(static_cast<unsigned char>(surf.flags)),
            });
        }

        // ---- static models (the props a stock map bakes in at compile time) --------------
        json jSmodels = json::array();
        for (auto i = 0u; world->dpvs.smodelDrawInsts && i < world->dpvs.smodelCount; i++)
        {
            const auto& inst = world->dpvs.smodelDrawInsts[i];
            const auto& p = inst.placement;
            jSmodels.push_back({
                {"model",  inst.model && inst.model->name ? inst.model->name : ""},
                {"origin", {p.origin[0], p.origin[1], p.origin[2]}               },
                {"axis",
                 {p.axis[0][0], p.axis[0][1], p.axis[0][2], p.axis[1][0], p.axis[1][1], p.axis[1][2], p.axis[2][0], p.axis[2][1], p.axis[2][2]}},
                {"scale",  p.scale                                               },
            });
        }

        json jSky = json::array();
        for (auto i = 0; world->skyStartSurfs && i < world->skySurfCount; i++)
            jSky.push_back(world->skyStartSurfs[i]);

        json root = {
            {"_type",             "enw-gfxworld"                                           },
            {"_version",          1                                                        },
            {"_game",             "t4"                                                     },
            {"name",              world->name ? world->name : ""                           },
            {"baseName",          world->baseName ? world->baseName : ""                   },
            {"units",             "engine inches, z up"                                    },
            {"vertexCount",       vertexCount                                              },
            {"vertexStride",      32                                                       },
            {"vertexLayout",      "f32 x y z nx ny nz u v"                                 },
            {"indexCount",        indexCount                                               },
            {"surfaceCount",      surfaceCount                                             },
            {"staticSurfaceCount", world->dpvs.staticSurfaceCount                          },
            {"litSurfs",          {world->dpvs.litSurfsBegin, world->dpvs.litSurfsEnd}      },
            {"decalSurfs",        {world->dpvs.decalSurfsBegin, world->dpvs.decalSurfsEnd}  },
            {"emissiveSurfs",     {world->dpvs.emissiveSurfsBegin, world->dpvs.emissiveSurfsEnd}},
            {"skyStartSurfs",     jSky                                                     },
            {"skyBoxModel",       world->skyBoxModel ? world->skyBoxModel : ""             },
            {"mins",              {world->mins[0], world->mins[1], world->mins[2]}         },
            {"maxs",              {world->maxs[0], world->maxs[1], world->maxs[2]}         },
            {"sunColorFromBsp",   {world->sunColorFromBsp[0], world->sunColorFromBsp[1], world->sunColorFromBsp[2]}},
            {"surfaceFields",     {"firstVertex", "vertexCount", "baseIndex", "triCount", "material", "brushModel", "flags"}},
            {"materials",         jMats                                                    },
            {"surfaces",          jSurfs                                                   },
            {"brushModels",       jModels                                                  },
            {"staticModels",      jSmodels                                                 },
        };

        const auto js = context.OpenAssetFile(std::format("world/{}.json", bsp));
        if (!js)
            return;
        *js << root.dump() << "\n";
    }
} // namespace gfx_world
